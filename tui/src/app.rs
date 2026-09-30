//! The ratatui application. Four tabs:
//! - "jogadores na sessão": with solo off, the remote peers on the game's P2P
//!   ports (who is in your session) enriched with GeoIP/PTR/owner; with solo on,
//!   the scored intrusion table (who is knocking).
//! - "histórico": intrusion attempts persisted across sessions.
//! - "logs da rede": the raw tcpdump traffic, always, regardless of solo.
//! - "status": route health and counters.
//!
//! Plus row selection with a detail popup, a help overlay, route-health, a
//! blocks/sec sparkline, and orange borders while solo is active.

use crate::alert;
use crate::classify::{classify_ptr, Kind};
use crate::config::{self, Config};
use crate::firewall::{self, Health};
use crate::history::{self, HistoryRow};
use crate::netlog::{NetLog, NetRow};
use crate::score::{threat_level, threat_score, Level};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders, Cell, Clear, List, ListItem, Paragraph, Row, Sparkline, Table, TableState, Tabs,
};
use ratatui::Frame;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CAP: usize = 2000;
const RATE_WINDOW: Duration = Duration::from_secs(10);
const FLOOD_HITS: usize = 40;
const SPARK_LEN: usize = 60;
const HISTORY_LIMIT: usize = 500;
/// A session peer not seen for this long is treated as having left the session.
const SESSION_TTL: Duration = Duration::from_secs(45);
/// Minimum packets before a session peer counts as a real player (filters probes).
const SESSION_PLAYER_MIN_PKTS: u64 = 5;
pub const TABS: [&str; 4] = ["jogadores na sessão", "histórico", "logs da rede", "status"];

const ACTIVE: Color = Color::Rgb(255, 140, 0);

/// A blocked intruder while solo is on (the "jogadores na sessão" tab, solo mode).
pub struct PeerStat {
    pub count: u64,
    pub last: String,
    pub ports: BTreeSet<u16>,
    pub incoming: bool,
    pub ptr: Option<String>,
    pub owner: String,
    pub geo: String,
    pub ptr_requested: bool,
    pub hits: VecDeque<Instant>,
}

impl PeerStat {
    fn recent(&self) -> usize {
        self.hits.len()
    }
    fn flooding(&self) -> bool {
        self.hits.len() >= FLOOD_HITS
    }
    fn kind(&self) -> Kind {
        classify_ptr(self.ptr.as_deref())
    }
    fn score(&self) -> u32 {
        threat_score(self.recent(), self.incoming, self.kind())
    }
    fn level(&self) -> Level {
        threat_level(self.score(), self.flooding())
    }
    fn prune(&mut self, now: Instant) {
        while let Some(&front) = self.hits.front() {
            if now.duration_since(front) > RATE_WINDOW {
                self.hits.pop_front();
            } else {
                break;
            }
        }
    }
}

/// A remote peer the console is talking to on the game's P2P ports while solo is
/// off: another player in the session, or a Rockstar relay/datacenter carrying it.
pub struct SessionPeer {
    pub count: u64,
    pub last: String,
    pub ports: BTreeSet<u16>,
    pub ptr: Option<String>,
    pub owner: String,
    pub geo: String,
    pub requested: bool,
    /// First time this peer was seen (time in the session).
    pub since: Instant,
    /// Last packet time, for pruning peers who left the session.
    pub last_seen: Instant,
}

impl SessionPeer {
    fn kind(&self, ip: &str) -> Kind {
        if config::is_rockstar(ip) {
            return Kind::Datacenter;
        }
        classify_ptr(self.ptr.as_deref())
    }

    /// Whether this peer reads as a real player joining the session, for the
    /// refill timer. A player is a direct P2P peer that is not a Rockstar relay
    /// or a known datacenter. Crucially this does NOT require a residential PTR:
    /// most console players have no reverse DNS, so waiting for `Kind::Player`
    /// left the timer running forever. Instead:
    /// - `Player` (residential PTR): yes.
    /// - `Unknown` but enrichment already finished (`ptr` is `Some`, even empty):
    ///   a direct peer with no hosting tell, so treat it as a player.
    /// - `Unknown` with enrichment still pending (`ptr` is `None`): wait, so a
    ///   cloud relay whose PTR is about to arrive is not mistaken for a player.
    /// - `Datacenter` (Rockstar or hosting PTR): never.
    ///
    /// A small packet floor filters out an isolated probe.
    fn is_player_candidate(&self, ip: &str) -> bool {
        if self.count < SESSION_PLAYER_MIN_PKTS {
            return false;
        }
        match self.kind(ip) {
            Kind::Player => true,
            Kind::Unknown => self.ptr.is_some(),
            Kind::Datacenter => false,
        }
    }
}

/// A frozen snapshot of a solo session, shown on the closing screen so its data
/// is not lost the instant you turn solo off.
pub struct SessionRecap {
    pub duration: Duration,
    pub total: u64,
    pub unique: usize,
    pub datacenters: usize,
    pub players: usize,
    pub unknown: usize,
    pub peak_per_sec: u64,
    pub high: usize,
    pub top: Vec<RecapPeer>,
}

pub struct RecapPeer {
    pub ip: String,
    pub kind: &'static str,
    pub count: u64,
    pub level: &'static str,
    pub incoming: bool,
}

pub struct App {
    pub cfg: Config,
    pub tab: usize,
    pub solo_on: bool,
    pub traffic: VecDeque<NetRow>,
    pub session_peers: HashMap<String, SessionPeer>,
    pub peers: HashMap<String, PeerStat>,
    pub history: Vec<HistoryRow>,
    pub status: Vec<String>,
    pub health: Health,
    pub flash: Option<String>,
    pub show_help: bool,
    pub detail: Option<String>,
    pub recap: Option<SessionRecap>,
    pub should_quit: bool,
    table_state: TableState,
    recorded: HashSet<String>,
    alerted: HashSet<String>,
    solo_since: Option<Instant>,
    /// When solo was last turned off, the moment the session started refilling.
    solo_off_at: Option<Instant>,
    /// How long it took, after solo off, for the first real player to appear.
    /// Set once, then frozen until the next solo cycle.
    fill_time: Option<Duration>,
    total_blocked: u64,
    spark: VecDeque<u64>,
    spark_sec: u64,
    spark_cur: u64,
    scroll: usize,
    max_scroll: usize,
    // Rects captured at render time, for mouse hit-testing.
    pub button_rect: Rect,
    pub tabs_rect: Rect,
    log: NetLog,
    ticks: u64,
}

impl App {
    pub fn new(cfg: Config) -> Self {
        let log = NetLog::spawn(&cfg);
        let solo_on = firewall::read_state() == "on";
        let status = firewall::status_lines(&cfg);
        let health = firewall::health(&cfg);
        App {
            cfg,
            tab: 0,
            solo_on,
            traffic: VecDeque::with_capacity(CAP),
            session_peers: HashMap::new(),
            peers: HashMap::new(),
            history: history::load(HISTORY_LIMIT),
            status,
            health,
            flash: None,
            show_help: false,
            detail: None,
            recap: None,
            should_quit: false,
            table_state: TableState::default(),
            recorded: HashSet::new(),
            alerted: HashSet::new(),
            solo_since: if solo_on { Some(Instant::now()) } else { None },
            solo_off_at: None,
            fill_time: None,
            total_blocked: 0,
            spark: VecDeque::from(vec![0; SPARK_LEN]),
            spark_sec: now_secs(),
            spark_cur: 0,
            scroll: 0,
            max_scroll: 0,
            button_rect: Rect::default(),
            tabs_rect: Rect::default(),
            log,
            ticks: 0,
        }
    }

    pub fn drain(&mut self) {
        while let Ok(row) = self.log.traffic_rx.try_recv() {
            // Remote peers on the game's P2P ports are the session participants.
            if let Some((ip, port)) = game_peer(&row, &self.cfg.console_ip) {
                let now = Instant::now();
                let new = !self.session_peers.contains_key(&ip);
                let sp = self
                    .session_peers
                    .entry(ip.clone())
                    .or_insert_with(|| SessionPeer {
                        count: 0,
                        last: row.time.clone(),
                        ports: BTreeSet::new(),
                        ptr: None,
                        owner: String::new(),
                        geo: String::new(),
                        requested: false,
                        since: now,
                        last_seen: now,
                    });
                sp.count += 1;
                sp.last = row.time.clone();
                sp.last_seen = now;
                if port != 0 {
                    sp.ports.insert(port);
                }
                // Rockstar relays are classified by IP, so skip their enrichment:
                // it keeps the serial PTR/whois queue short so the players' PTRs
                // (which the fill timer waits on) arrive fast.
                if new && !config::is_rockstar(&ip) {
                    self.log.request_ptr(&ip);
                    if let Some(sp) = self.session_peers.get_mut(&ip) {
                        sp.requested = true;
                    }
                }
            }
            push_cap(&mut self.traffic, row);
        }
        while let Ok(row) = self.log.block_rx.try_recv() {
            self.total_blocked += 1;
            self.spark_cur += 1;
            let new = !self.peers.contains_key(&row.ip);
            let e = self
                .peers
                .entry(row.ip.clone())
                .or_insert_with(|| PeerStat {
                    count: 0,
                    last: row.time.clone(),
                    ports: BTreeSet::new(),
                    incoming: row.incoming,
                    ptr: None,
                    owner: String::new(),
                    geo: String::new(),
                    ptr_requested: false,
                    hits: VecDeque::new(),
                });
            e.count += 1;
            e.last = row.time;
            e.incoming = row.incoming;
            if row.port != 0 {
                e.ports.insert(row.port);
            }
            e.hits.push_back(Instant::now());
            if new {
                self.log.request_ptr(&row.ip);
                if let Some(p) = self.peers.get_mut(&row.ip) {
                    p.ptr_requested = true;
                }
            }
        }
        while let Ok((ip, name, owner, geo)) = self.log.ptr_rx.try_recv() {
            if let Some(p) = self.peers.get_mut(&ip) {
                p.ptr = Some(name.clone());
                p.owner = owner.clone();
                p.geo = geo.clone();
                // Record to history once we know the kind (PTR resolved).
                if self.recorded.insert(ip.clone()) {
                    let kind = classify_ptr(Some(&name));
                    history::record_intruder(&ip, kind_label(kind), &name);
                }
            }
            if let Some(sp) = self.session_peers.get_mut(&ip) {
                sp.ptr = Some(name);
                sp.owner = owner;
                sp.geo = geo;
            }
        }
    }

    pub fn tick(&mut self) {
        self.ticks += 1;
        let now = Instant::now();
        for p in self.peers.values_mut() {
            p.prune(now);
        }
        // Drop session peers who stopped talking (they left the session).
        self.session_peers
            .retain(|_, sp| now.duration_since(sp.last_seen) < SESSION_TTL);
        self.roll_spark();
        self.maybe_alert();
        // Fill timer: after solo off, stop at the first peer that reads as a real
        // player (not a Rockstar relay/datacenter). Checked every tick so the
        // frozen value is accurate to ~200ms.
        let has_player = self
            .session_peers
            .iter()
            .any(|(ip, sp)| sp.is_player_candidate(ip));
        if should_stop_fill(
            self.solo_on,
            self.solo_off_at.is_some(),
            self.fill_time.is_some(),
            has_player,
        ) {
            if let Some(t0) = self.solo_off_at {
                self.fill_time = Some(t0.elapsed());
            }
        }
        if self.ticks.is_multiple_of(10) {
            self.status = firewall::status_lines(&self.cfg);
            self.health = firewall::health(&self.cfg);
            let was = self.solo_on;
            let on = firewall::read_state() == "on";
            // Catch a solo toggle done from outside the TUI (another terminal),
            // so the fill timer still starts/clears on the transition.
            if on && !was {
                self.solo_off_at = None;
                self.fill_time = None;
            } else if !on && was {
                self.solo_off_at = Some(now);
                self.fill_time = None;
            }
            if on && self.solo_since.is_none() {
                self.solo_since = Some(now);
            } else if !on {
                self.solo_since = None;
            }
            self.solo_on = on;
            if self.tab == 1 {
                self.history = history::load(HISTORY_LIMIT);
            }
        }
    }

    /// Push once per IP when it first reads as a High threat.
    fn maybe_alert(&mut self) {
        let url = match &self.cfg.ntfy_url {
            Some(u) => u.clone(),
            None => return,
        };
        let mut to_alert = Vec::new();
        for (ip, st) in &self.peers {
            if st.level() == Level::High && !self.alerted.contains(ip) {
                to_alert.push((ip.clone(), st.kind(), st.recent(), st.owner.clone()));
            }
        }
        for (ip, kind, recent, owner) in to_alert {
            self.alerted.insert(ip.clone());
            let body = format!("{ip} ({}) {recent} pkts/10s {owner}", kind_label(kind));
            alert::notify(&url, "rdo-solo: tentativa ALTA", &body);
        }
    }

    fn roll_spark(&mut self) {
        let now = now_secs();
        while self.spark_sec < now {
            push_cap_u(&mut self.spark, self.spark_cur, SPARK_LEN);
            self.spark_cur = 0;
            self.spark_sec += 1;
        }
    }

    pub fn next_tab(&mut self) {
        self.set_tab((self.tab + 1) % TABS.len());
    }
    pub fn prev_tab(&mut self) {
        self.set_tab((self.tab + TABS.len() - 1) % TABS.len());
    }
    pub fn set_tab(&mut self, t: usize) {
        self.tab = t.min(TABS.len() - 1);
        self.scroll = 0;
        if self.tab == 1 {
            self.history = history::load(HISTORY_LIMIT);
        }
    }

    /// The "jogadores na sessão" tab (0) is a selectable table in both modes;
    /// everything else is plain scroll.
    fn in_table(&self) -> bool {
        self.tab == 0
    }
    /// Row count of the tab-0 table, mode-dependent.
    fn table_len(&self) -> usize {
        if self.solo_on {
            self.peers.len()
        } else {
            self.session_peers.len()
        }
    }

    pub fn nav_up(&mut self) {
        if self.in_table() {
            if self.table_len() == 0 {
                return;
            }
            let i = self
                .table_state
                .selected()
                .map(|i| i.saturating_sub(1))
                .unwrap_or(0);
            self.table_state.select(Some(i));
        } else {
            self.scroll = (self.scroll + 1).min(self.max_scroll);
        }
    }
    pub fn nav_down(&mut self, page: bool) {
        let step = if page { 10 } else { 1 };
        if self.in_table() {
            let n = self.table_len();
            if n == 0 {
                return;
            }
            let i = self
                .table_state
                .selected()
                .map(|i| (i + step).min(n - 1))
                .unwrap_or(0);
            self.table_state.select(Some(i));
        } else {
            self.scroll = self.scroll.saturating_sub(step);
        }
    }
    pub fn page_up(&mut self) {
        if self.in_table() {
            let i = self
                .table_state
                .selected()
                .map(|i| i.saturating_sub(10))
                .unwrap_or(0);
            self.table_state.select(Some(i));
        } else {
            self.scroll = (self.scroll + 10).min(self.max_scroll);
        }
    }
    pub fn scroll_top(&mut self) {
        self.scroll = self.max_scroll;
    }
    pub fn scroll_follow(&mut self) {
        self.scroll = 0;
    }

    /// Enter: open the detail popup for the selected row (tab 0 only).
    pub fn open_detail(&mut self) {
        if !self.in_table() {
            return;
        }
        if let Some(ip) = self.selected_ip() {
            self.detail = Some(ip);
        }
    }
    pub fn close_overlays(&mut self) {
        self.detail = None;
        self.show_help = false;
    }
    pub fn toggle_help(&mut self) {
        self.show_help = !self.show_help;
    }

    fn selected_ip(&self) -> Option<String> {
        let sel = self.table_state.selected()?;
        if self.solo_on {
            self.sorted_peers().get(sel).map(|(ip, _)| (*ip).clone())
        } else {
            self.sorted_session().get(sel).map(|(ip, _)| (*ip).clone())
        }
    }

    /// Peers sorted by threat (level, then score, then IP) for a stable order.
    fn sorted_peers(&self) -> Vec<(&String, &PeerStat)> {
        let mut v: Vec<(&String, &PeerStat)> = self.peers.iter().collect();
        v.sort_by(|a, b| {
            (b.1.level() as u8)
                .cmp(&(a.1.level() as u8))
                .then(b.1.score().cmp(&a.1.score()))
                .then(a.0.cmp(b.0))
        });
        v
    }

    /// Session peers sorted by volume (packets), then IP.
    fn sorted_session(&self) -> Vec<(&String, &SessionPeer)> {
        let mut v: Vec<(&String, &SessionPeer)> = self.session_peers.iter().collect();
        v.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(a.0.cmp(b.0)));
        v
    }

    /// Freeze the current session into a recap before the buffers are cleared.
    fn build_recap(&self) -> SessionRecap {
        let (mut datacenters, mut players, mut unknown, mut high) = (0, 0, 0, 0);
        for st in self.peers.values() {
            match st.kind() {
                Kind::Datacenter => datacenters += 1,
                Kind::Player => players += 1,
                Kind::Unknown => unknown += 1,
            }
            if st.level() == Level::High {
                high += 1;
            }
        }
        let top = self
            .sorted_peers()
            .iter()
            .take(8)
            .map(|(ip, st)| RecapPeer {
                ip: (*ip).clone(),
                kind: kind_label(st.kind()),
                count: st.count,
                level: st.level().label(),
                incoming: st.incoming,
            })
            .collect();
        SessionRecap {
            duration: self.solo_since.map(|s| s.elapsed()).unwrap_or_default(),
            total: self.total_blocked,
            unique: self.peers.len(),
            datacenters,
            players,
            unknown,
            peak_per_sec: self.spark.iter().copied().max().unwrap_or(0),
            high,
            top,
        }
    }

    pub fn dismiss_recap(&mut self) {
        self.recap = None;
    }

    pub fn toggle_solo(&mut self) {
        let res = if self.solo_on {
            firewall::cmd_off(&self.cfg)
        } else {
            firewall::cmd_on(&self.cfg)
        };
        match res {
            Ok(()) => {
                // Going off: capture the session before wiping the buffers.
                if self.solo_on {
                    self.recap = Some(self.build_recap());
                }
                self.solo_on = !self.solo_on;
                self.solo_since = if self.solo_on {
                    Some(Instant::now())
                } else {
                    None
                };
                // Off starts the fill timer; on clears it.
                self.solo_off_at = if self.solo_on {
                    None
                } else {
                    Some(Instant::now())
                };
                self.fill_time = None;
                self.traffic.clear();
                self.session_peers.clear();
                self.peers.clear();
                self.recorded.clear();
                self.alerted.clear();
                self.total_blocked = 0;
                self.scroll = 0;
                self.detail = None;
                self.table_state.select(None);
                self.flash = Some(if self.solo_on {
                    "solo LIGADO".into()
                } else {
                    "solo DESLIGADO".into()
                });
            }
            Err(e) => self.flash = Some(format!("falhou: {e}")),
        }
    }

    /// Value for the "tempo sozinho na sessão" footer timer: running while the
    /// session fills back up after solo off, then frozen at the moment the first
    /// player joined (green). None while solo is on or before the first solo-off
    /// of this run.
    fn fill_timer(&self) -> Option<(String, Color)> {
        if self.solo_on {
            return None;
        }
        if let Some(d) = self.fill_time {
            return Some((fmt_dur(d), Color::Green));
        }
        let t0 = self.solo_off_at?;
        Some((fmt_dur(t0.elapsed()), ACTIVE))
    }

    /// One-line session recap, printed on quit.
    pub fn session_summary(&self) -> Option<String> {
        let since = self.solo_since?;
        Some(format!(
            "sessão solo: {} · {} bloqueados · {} IPs distintos",
            fmt_dur(since.elapsed()),
            self.total_blocked,
            self.peers.len()
        ))
    }
}

fn kind_label(k: Kind) -> &'static str {
    match k {
        Kind::Player => "player",
        Kind::Datacenter => "datacenter",
        Kind::Unknown => "?",
    }
}

fn kind_color(k: Kind) -> Color {
    match k {
        Kind::Player => Color::Green,
        Kind::Datacenter => Color::Red,
        Kind::Unknown => Color::DarkGray,
    }
}

/// The "tipo" label for a session peer. Unlike the intrusion table, a direct P2P
/// peer here is a fellow player unless it is a Rockstar relay or a hosting IP, so
/// an unresolved/no-PTR peer reads as "player" (console players rarely have a PTR)
/// rather than "?".
fn session_type(ip: &str, ptr: Option<&str>) -> (&'static str, Color) {
    if config::is_rockstar(ip) {
        return ("Rockstar", Color::Red);
    }
    match classify_ptr(ptr) {
        Kind::Datacenter => ("datacenter", Color::Red),
        _ => ("player", Color::Green),
    }
}

/// Whether the refill timer should freeze now: solo is off, a start time exists,
/// no result is stored yet, and at least one real player is in the session.
fn should_stop_fill(solo_on: bool, has_start: bool, has_result: bool, has_player: bool) -> bool {
    !solo_on && has_start && !has_result && has_player
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
fn push_cap<T>(buf: &mut VecDeque<T>, item: T) {
    if buf.len() == CAP {
        buf.pop_front();
    }
    buf.push_back(item);
}
fn push_cap_u(buf: &mut VecDeque<u64>, item: u64, cap: usize) {
    if buf.len() == cap {
        buf.pop_front();
    }
    buf.push_back(item);
}

/// The non-console endpoint IP (port stripped) of a traffic row.
fn remote_ip(row: &NetRow, console: &str) -> Option<String> {
    for ep in [&row.src, &row.dst] {
        let ip = strip_port(ep);
        if !ip.is_empty() && ip != console && ip.contains('.') {
            return Some(ip);
        }
    }
    None
}
fn strip_port(ep: &str) -> String {
    match ep.rfind('.') {
        Some(i) => ep[..i].to_string(),
        None => ep.to_string(),
    }
}
fn endpoint_port(ep: &str) -> u16 {
    ep.rsplit('.')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(0)
}

/// The remote peer and game port of a traffic row, when either endpoint is on a
/// game P2P port. This is what puts a peer in "jogadores na sessão".
fn game_peer(row: &NetRow, console: &str) -> Option<(String, u16)> {
    let src_game = is_game_endpoint(&row.src);
    let dst_game = is_game_endpoint(&row.dst);
    if !src_game && !dst_game {
        return None;
    }
    let ip = remote_ip(row, console)?;
    let port = if dst_game {
        endpoint_port(&row.dst)
    } else {
        endpoint_port(&row.src)
    };
    Some((ip, port))
}

fn border_style(solo_on: bool) -> Style {
    if solo_on {
        Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    }
}
fn framed(title: String, solo_on: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(solo_on))
        .title(title)
}

pub fn ui(f: &mut Frame, app: &mut App) {
    // The closing screen owns the whole frame until a key dismisses it.
    if let Some(recap) = &app.recap {
        render_recap(f, recap);
        return;
    }

    // The header's second row exists only to hold a warning, so drop it when
    // there is none: 3 tall normally, 4 when a warning must be shown.
    let header_h = if health_warning(&app.health, app.solo_on).is_some() {
        4
    } else {
        3
    };
    let mut constraints = vec![Constraint::Length(header_h), Constraint::Length(3)];
    if app.solo_on {
        constraints.push(Constraint::Length(3));
    }
    constraints.push(Constraint::Min(0));
    constraints.push(Constraint::Length(1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(f.area());

    render_header(f, app, chunks[0]);
    render_tabs(f, app, chunks[1]);
    let (body, footer) = if app.solo_on {
        render_sparkline(f, app, chunks[2]);
        (chunks[3], chunks[4])
    } else {
        (chunks[2], chunks[3])
    };
    match app.tab {
        0 => render_players(f, app, body),
        1 => render_history(f, app, body),
        2 => render_traffic(f, app, body),
        _ => {
            app.max_scroll = 0;
            render_status(f, app, body);
        }
    }
    render_footer(f, app, footer);

    if app.detail.is_some() {
        render_detail(f, app);
    }
    if app.show_help {
        render_help(f);
    }
}

fn render_header(f: &mut Frame, app: &mut App, area: Rect) {
    let button = if app.solo_on {
        " [s] DESLIGAR MODO SOLO "
    } else {
        " [s] LIGAR MODO SOLO "
    };

    let title = match &app.flash {
        Some(m) => format!("rdo-solo — {m}   [?] ajuda"),
        None => "rdo-solo   [?] ajuda".to_string(),
    };
    let block = framed(title, app.solo_on);
    let inner = block.inner(area);
    f.render_widget(block, area);

    // Row 1: identity (left) + health dots (right). Row 2: full-width, for the
    // warning (which can be long) or the session summary.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Length(1)])
        .split(inner);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(20), Constraint::Length(44)])
        .split(rows[0]);
    let (left1, right1, row2) = (cols[0], cols[1], rows[1]);

    // Button rect for mouse hit-testing, relative to the left column.
    // Button first (with a one-space left pad), then the console IP.
    app.button_rect = Rect {
        x: left1.x + 1,
        y: left1.y,
        width: button.len() as u16,
        height: 1,
    };

    let l1 = Line::from(vec![
        Span::raw(" "),
        Span::styled(
            button,
            Style::default()
                .fg(Color::White)
                .bg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  console: "),
        Span::styled(
            app.cfg
                .console_label
                .clone()
                .unwrap_or_else(|| app.cfg.console_ip.clone()),
            Style::default().fg(Color::Cyan),
        ),
    ]);
    f.render_widget(Paragraph::new(l1), left1);
    f.render_widget(
        Paragraph::new(health_dots(&app.health)).alignment(Alignment::Right),
        right1,
    );

    // Row 2, full width: the warning, when there is one.
    let row2_line = health_warning(&app.health, app.solo_on).unwrap_or_else(|| Line::from(""));
    f.render_widget(Paragraph::new(row2_line), row2);
}

fn dot(ok: bool, label: &str) -> Vec<Span<'static>> {
    let color = if ok { Color::Green } else { Color::Red };
    vec![
        Span::styled("●", Style::default().fg(color)),
        Span::styled(
            format!(" {label}  "),
            Style::default().fg(if ok { Color::Gray } else { Color::Red }),
        ),
    ]
}

fn health_dots(h: &Health) -> Line<'static> {
    let mut spans = Vec::new();
    spans.extend(dot(h.forwarding, "encaminha"));
    spans.extend(dot(h.redirects_ok, "redirec."));
    spans.extend(dot(h.route_rule, "rota"));
    spans.extend(dot(h.console_present && !h.ip_mismatch, "console"));
    Line::from(spans)
}

fn health_warning(h: &Health, solo_on: bool) -> Option<Line<'static>> {
    let loud = Style::default()
        .fg(Color::Black)
        .bg(Color::Red)
        .add_modifier(Modifier::BOLD);
    let span = if h.ip_mismatch {
        let live = h.live_ip.clone().unwrap_or_default();
        Span::styled(format!("⚠ console em {live}, filtro mira outro IP"), loud)
    } else if solo_on && h.console_present && h.gateway_pkts == 0 {
        Span::styled("⚠ console NÃO passa por aqui (bloqueio inútil)", loud)
    } else if h.console_ipv6 {
        Span::styled(
            "⚠ Xbox com IPv6, o filtro não cobre IPv6",
            Style::default().fg(ACTIVE),
        )
    } else if !h.ok() {
        Span::styled("⚠ veja a aba status", Style::default().fg(Color::Red))
    } else {
        return None;
    };
    Some(Line::from(span))
}

fn render_tabs(f: &mut Frame, app: &mut App, area: Rect) {
    app.tabs_rect = area;
    let titles: Vec<Line> = TABS.iter().map(|t| Line::from(*t)).collect();
    let tabs = Tabs::new(titles)
        .select(app.tab)
        .block(framed(String::new(), app.solo_on))
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(tabs, area);
}

fn render_sparkline(f: &mut Frame, app: &App, area: Rect) {
    let data: Vec<u64> = app.spark.iter().copied().collect();
    let peak = data.iter().copied().max().unwrap_or(0);
    let spark = Sparkline::default()
        .block(framed(
            format!(" bloqueios/s (pico {peak}/s) "),
            app.solo_on,
        ))
        .data(&data)
        .style(Style::default().fg(ACTIVE));
    f.render_widget(spark, area);
}

fn visible_rows(area: Rect) -> usize {
    area.height.saturating_sub(2) as usize
}
fn window(total: usize, rows: usize, scroll: usize) -> (usize, usize) {
    let max_scroll = total.saturating_sub(rows);
    let s = scroll.min(max_scroll);
    (max_scroll - s, max_scroll)
}

/// Tab 0: the intrusion table (solo on) or the session-players table (solo off).
fn render_players(f: &mut Frame, app: &mut App, area: Rect) {
    if app.solo_on {
        render_solo_table(f, app, area);
    } else {
        render_session_players(f, app, area);
    }
}

fn render_traffic(f: &mut Frame, app: &mut App, area: Rect) {
    let rows = visible_rows(area);
    let (start, max_scroll) = window(app.traffic.len(), rows, app.scroll);
    app.max_scroll = max_scroll;
    let items: Vec<ListItem> = app
        .traffic
        .iter()
        .skip(start)
        .take(rows)
        .map(|r: &NetRow| {
            let p2p = is_game_endpoint(&r.src) || is_game_endpoint(&r.dst);
            let base = if p2p { Color::Green } else { Color::Gray };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{} ", r.time), Style::default().fg(Color::DarkGray)),
                Span::styled(format!("{:<21} ", r.src), Style::default().fg(Color::Cyan)),
                Span::raw(if r.dst.is_empty() { "" } else { "-> " }),
                Span::styled(
                    format!("{:<21} ", r.dst),
                    Style::default().fg(Color::Magenta),
                ),
                Span::styled(r.info.clone(), Style::default().fg(base)),
            ]))
        })
        .collect();
    let follow = if app.scroll == 0 { "" } else { " [pausado]" };
    let title = format!(
        " logs da rede — tráfego ({}){} · verde=P2P ",
        app.traffic.len(),
        follow
    );
    f.render_widget(List::new(items).block(framed(title, app.solo_on)), area);
}

/// Solo off: who is in the session (remote peers on the game's P2P ports).
fn render_session_players(f: &mut Frame, app: &mut App, area: Rect) {
    app.max_scroll = 0;
    let n = app.session_peers.len();
    match app.table_state.selected() {
        Some(_) if n == 0 => app.table_state.select(None),
        Some(i) if i >= n => app.table_state.select(Some(n - 1)),
        _ => {}
    }

    let header = Row::new(["IP", "local", "tipo", "provedor", "pkts", "tempo", "portas"]).style(
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    );

    // Scope the peers borrow: cells are owned so the stateful render can take
    // &mut app.table_state freely.
    let rows: Vec<Row> = {
        let peers = app.sorted_session();
        peers
            .iter()
            .map(|(ip, sp)| {
                let (kind_txt, kcolor) = session_type(ip, sp.ptr.as_deref());
                let ports = sp
                    .ports
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let geo = if sp.geo.is_empty() { "—" } else { &sp.geo };
                let owner = if sp.owner.is_empty() {
                    "—".to_string()
                } else {
                    trunc(&sp.owner, 22)
                };
                Row::new(vec![
                    Cell::from((*ip).clone()).style(Style::default().fg(Color::White)),
                    Cell::from(geo.to_string()).style(Style::default().fg(Color::Cyan)),
                    Cell::from(kind_txt).style(Style::default().fg(kcolor)),
                    Cell::from(owner).style(Style::default().fg(Color::Gray)),
                    Cell::from(sp.count.to_string()).style(Style::default().fg(Color::Yellow)),
                    Cell::from(fmt_dur(sp.since.elapsed()))
                        .style(Style::default().fg(Color::DarkGray)),
                    Cell::from(ports).style(Style::default().fg(Color::Yellow)),
                ])
            })
            .collect()
    };

    let widths = [
        Constraint::Length(16),
        Constraint::Length(16),
        Constraint::Length(11),
        Constraint::Min(10),
        Constraint::Length(6),
        Constraint::Length(7),
        Constraint::Length(12),
    ];
    let title = format!(
        " jogadores na sessão — {} peer(s) P2P · [Enter] detalhe ",
        n
    );
    let table = Table::new(rows, widths)
        .header(header)
        .block(framed(title, app.solo_on))
        .row_highlight_style(
            Style::default()
                .bg(Color::Rgb(60, 60, 60))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▶ ");
    f.render_stateful_widget(table, area, &mut app.table_state);

    if n == 0 {
        let hint = Paragraph::new(Line::from(Span::styled(
            "  aguardando tráfego P2P... (entre numa sessão online)",
            Style::default().fg(Color::DarkGray),
        )));
        let inner = Rect {
            x: area.x + 1,
            y: area.y + 2,
            width: area.width.saturating_sub(2),
            height: 1,
        };
        f.render_widget(hint, inner);
    }
}

/// Solo on: the scored intrusion table (who is knocking while you are alone).
fn render_solo_table(f: &mut Frame, app: &mut App, area: Rect) {
    app.max_scroll = 0;
    let n = app.peers.len();
    // Keep the selection within bounds as the set changes.
    match app.table_state.selected() {
        Some(_) if n == 0 => app.table_state.select(None),
        Some(i) if i >= n => app.table_state.select(Some(n - 1)),
        _ => {}
    }

    let header = Row::new([
        "ameaça", "IP", "local", "tipo", "pkts", "10s", "dir", "portas",
    ])
    .style(
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    );

    // Scope the peers borrow: every cell below is owned, so `rows` outlives it
    // and the stateful render can take &mut app.table_state freely.
    let rows: Vec<Row> = {
        let peers = app.sorted_peers();
        peers
            .iter()
            .map(|(ip, st)| {
                let level = st.level();
                let (lvl_txt, lvl_color) = match level {
                    Level::High => (level.label(), Color::Red),
                    Level::Medium => (level.label(), ACTIVE),
                    Level::Low => (level.label(), Color::DarkGray),
                };
                let dir = if st.incoming { "←" } else { "→" };
                let ports = st
                    .ports
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let kind = st.kind();
                let geo = if st.geo.is_empty() { "—" } else { &st.geo };
                let marker = if st.flooding() { "▲ " } else { "  " };
                Row::new(vec![
                    Cell::from(format!("{marker}{lvl_txt}"))
                        .style(Style::default().fg(lvl_color).add_modifier(Modifier::BOLD)),
                    Cell::from((*ip).clone()).style(Style::default().fg(Color::White)),
                    Cell::from(geo.to_string()).style(Style::default().fg(Color::Cyan)),
                    Cell::from(kind_label(kind)).style(Style::default().fg(kind_color(kind))),
                    Cell::from(st.count.to_string()).style(Style::default().fg(Color::Red)),
                    Cell::from(st.recent().to_string()).style(
                        Style::default().fg(if st.flooding() { ACTIVE } else { Color::Yellow }),
                    ),
                    Cell::from(dir).style(Style::default().fg(if st.incoming {
                        Color::Red
                    } else {
                        Color::DarkGray
                    })),
                    Cell::from(ports).style(Style::default().fg(Color::Yellow)),
                ])
            })
            .collect()
    };

    let widths = [
        Constraint::Length(11),
        Constraint::Length(16),
        Constraint::Length(16),
        Constraint::Length(11),
        Constraint::Length(6),
        Constraint::Length(5),
        Constraint::Length(4),
        Constraint::Min(8),
    ];
    let title = format!(
        " jogadores na sessão — SOLO · tentativas ({} IPs) · [Enter] detalhe ",
        n
    );
    let table = Table::new(rows, widths)
        .header(header)
        .block(framed(title, app.solo_on))
        .row_highlight_style(
            Style::default()
                .bg(Color::Rgb(60, 60, 60))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▶ ");
    f.render_stateful_widget(table, area, &mut app.table_state);
}

fn render_history(f: &mut Frame, app: &mut App, area: Rect) {
    let rows = visible_rows(area).saturating_sub(1);
    let (start, max_scroll) = window(app.history.len(), rows, app.scroll);
    app.max_scroll = max_scroll;
    let mut items = vec![ListItem::new(Line::from(Span::styled(
        format!("  {:<19} {:<16} {:<11} {}", "quando", "IP", "tipo", "PTR"),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )))];
    if app.history.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "  sem histórico ainda (grava as tentativas de cada sessão)",
            Style::default().fg(Color::DarkGray),
        ))));
    }
    for h in app.history.iter().skip(start).take(rows) {
        let kcolor = match h.kind.as_str() {
            "datacenter" => Color::Red,
            "player" => Color::Green,
            _ => Color::DarkGray,
        };
        items.push(ListItem::new(Line::from(vec![
            Span::styled(
                format!("  {:<19} ", h.time),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(format!("{:<16} ", h.ip), Style::default().fg(Color::White)),
            Span::styled(format!("{:<11} ", h.kind), Style::default().fg(kcolor)),
            Span::styled(trunc(&h.ptr, 40), Style::default().fg(Color::Gray)),
        ])));
    }
    let title = format!(
        " histórico — tentativas registradas ({}) ",
        app.history.len()
    );
    f.render_widget(List::new(items).block(framed(title, app.solo_on)), area);
}

fn render_status(f: &mut Frame, app: &App, area: Rect) {
    let text: Vec<Line> = app.status.iter().map(|l| Line::from(l.clone())).collect();
    f.render_widget(
        Paragraph::new(text).block(framed(" status ".into(), app.solo_on)),
        area,
    );
}

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let hint = if app.solo_on {
        " · ← entrada · ▲ flood · Enter detalhe"
    } else if app.tab == 0 {
        " · jogadores na sessão · Enter detalhe"
    } else {
        ""
    };
    let shortcuts = Line::from(vec![
        Span::styled(" Tab", Style::default().fg(Color::Cyan)),
        Span::raw(" aba  "),
        Span::styled("s", Style::default().fg(Color::Cyan)),
        Span::raw(" solo  "),
        Span::styled("↑↓", Style::default().fg(Color::Cyan)),
        Span::raw(if app.tab == 0 {
            " seleciona  "
        } else {
            " rola  "
        }),
        Span::styled("?", Style::default().fg(Color::Cyan)),
        Span::raw(" ajuda  "),
        Span::styled("q", Style::default().fg(Color::Cyan)),
        Span::raw(" sai"),
        Span::styled(hint, Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(shortcuts), area);

    // Session info lives here now (right-aligned): purely informative, so it
    // stays out of the header. Only while solo is on.
    if app.solo_on {
        let up = app
            .solo_since
            .map(|s| fmt_dur(s.elapsed()))
            .unwrap_or_default();
        let info = Line::from(vec![
            Span::styled(
                "SOLO ATIVO",
                Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    " · há {up} · {} bloq · {} IPs ",
                    app.total_blocked,
                    app.peers.len()
                ),
                Style::default().fg(Color::Gray),
            ),
        ]);
        f.render_widget(Paragraph::new(info).alignment(Alignment::Right), area);
    } else if let Some((value, color)) = app.fill_timer() {
        // Solo off: the refill timer, right-aligned. Never overlaps the session
        // info above, which only shows while solo is on.
        let info = Line::from(vec![
            Span::styled(
                "Tempo sozinho na sessão: ",
                Style::default().fg(Color::Gray),
            ),
            Span::styled(
                format!("{value} "),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
        ]);
        f.render_widget(Paragraph::new(info).alignment(Alignment::Right), area);
    }
}

fn render_recap(f: &mut Frame, r: &SessionRecap) {
    let full = f.area();
    f.render_widget(Clear, full);

    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "  SESSÃO SOLO ENCERRADA",
            Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        recap_kv("duração", &fmt_dur(r.duration)),
        recap_kv("pacotes bloqueados", &r.total.to_string()),
        recap_kv("IPs distintos", &r.unique.to_string()),
        recap_kv("pico", &format!("{}/s", r.peak_per_sec)),
        recap_kv(
            "por tipo",
            &format!(
                "{} datacenter · {} player · {} ?",
                r.datacenters, r.players, r.unknown
            ),
        ),
        recap_kv("ameaças ALTAS", &r.high.to_string()),
        Line::from(""),
    ];

    if r.top.is_empty() {
        lines.push(Line::from(Span::styled(
            "  nenhuma tentativa registrada nesta sessão.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            "  quem mais insistiu:",
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            format!(
                "  {:<16} {:<11} {:>6}  {:<3} {}",
                "IP", "tipo", "pkts", "dir", "ameaça"
            ),
            Style::default().fg(Color::DarkGray),
        )));
        for p in &r.top {
            let kcolor = match p.kind {
                "datacenter" => Color::Red,
                "player" => Color::Green,
                _ => Color::DarkGray,
            };
            let lvl_color = match p.level {
                "ALTO" => Color::Red,
                "médio" => ACTIVE,
                _ => Color::DarkGray,
            };
            let dir = if p.incoming { "←" } else { "→" };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {:<16} ", p.ip),
                    Style::default().fg(Color::White),
                ),
                Span::styled(format!("{:<11} ", p.kind), Style::default().fg(kcolor)),
                Span::styled(format!("{:>6}  ", p.count), Style::default().fg(Color::Red)),
                Span::styled(
                    format!("{dir:<3} "),
                    Style::default().fg(if p.incoming {
                        Color::Red
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::styled(
                    p.level.to_string(),
                    Style::default().fg(lvl_color).add_modifier(Modifier::BOLD),
                ),
            ]));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  pressione qualquer tecla para voltar aos logs",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD))
        .title(" resumo da sessão ");
    f.render_widget(Paragraph::new(lines).block(block), full);
}

fn recap_kv(k: &str, v: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {k:<20} "), Style::default().fg(Color::Gray)),
        Span::styled(
            v.to_string(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn render_detail(f: &mut Frame, app: &App) {
    let ip = match &app.detail {
        Some(ip) => ip,
        None => return,
    };
    // Prefer the intruder record while solo is on, the session record otherwise.
    let lines = if app.solo_on {
        app.peers
            .get(ip)
            .map(|st| detail_peer_lines(ip, st))
            .or_else(|| {
                app.session_peers
                    .get(ip)
                    .map(|sp| detail_session_lines(ip, sp))
            })
    } else {
        app.session_peers
            .get(ip)
            .map(|sp| detail_session_lines(ip, sp))
            .or_else(|| app.peers.get(ip).map(|st| detail_peer_lines(ip, st)))
    };
    let lines = match lines {
        Some(l) => l,
        None => return,
    };
    let area = centered(60, 55, f.area());
    f.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD))
        .title(" detalhe do peer ");
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn ptr_text(ptr: &Option<String>) -> String {
    match ptr {
        None => "consultando...".to_string(),
        Some(s) if s.is_empty() => "sem PTR reverso".to_string(),
        Some(s) => s.clone(),
    }
}
fn or_dash(s: &str, empty: &str) -> String {
    if s.is_empty() {
        empty.to_string()
    } else {
        s.to_string()
    }
}
fn ports_text(ports: &BTreeSet<u16>) -> String {
    ports
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn detail_peer_lines(ip: &str, st: &PeerStat) -> Vec<Line<'static>> {
    vec![
        kv("IP", ip),
        kv(
            "ameaça",
            &format!("{} (score {})", st.level().label(), st.score()),
        ),
        kv("tipo", kind_label(st.kind())),
        kv("local", &or_dash(&st.geo, "(sem GeoIP)")),
        kv("dono", &or_dash(&st.owner, "(whois indisponível)")),
        kv("PTR", &ptr_text(&st.ptr)),
        kv(
            "pacotes",
            &format!("{} total · {} em 10s", st.count, st.recent()),
        ),
        kv(
            "direção",
            if st.incoming {
                "← entrada (tentando te alcançar)"
            } else {
                "→ saída"
            },
        ),
        kv("portas", &ports_text(&st.ports)),
        kv("última", &st.last),
        Line::from(""),
        Line::from(Span::styled(
            "  Esc fecha",
            Style::default().fg(Color::DarkGray),
        )),
    ]
}

fn detail_session_lines(ip: &str, sp: &SessionPeer) -> Vec<Line<'static>> {
    let tipo = if config::is_rockstar(ip) {
        "Rockstar (relay/datacenter)".to_string()
    } else {
        session_type(ip, sp.ptr.as_deref()).0.to_string()
    };
    vec![
        kv("IP", ip),
        kv("na sessão", "peer P2P (não é intrusão)"),
        kv("tipo", &tipo),
        kv("local", &or_dash(&sp.geo, "(sem GeoIP)")),
        kv("dono", &or_dash(&sp.owner, "(whois indisponível)")),
        kv("PTR", &ptr_text(&sp.ptr)),
        kv("pacotes", &sp.count.to_string()),
        kv("tempo na sessão", &fmt_dur(sp.since.elapsed())),
        kv("portas", &ports_text(&sp.ports)),
        kv("última", &sp.last),
        Line::from(""),
        Line::from(Span::styled(
            "  Esc fecha",
            Style::default().fg(Color::DarkGray),
        )),
    ]
}

fn render_help(f: &mut Frame) {
    let area = centered(64, 72, f.area());
    f.render_widget(Clear, area);
    let lines = vec![
        Line::from(Span::styled(
            "  rdo-solo-tui — ajuda",
            Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        help_row("Tab / ← →", "muda de aba"),
        help_row("1..4", "vai direto para a aba"),
        help_row("s", "liga / desliga o modo solo"),
        help_row("↑ ↓ / j k", "seleciona (aba jogadores) ou rola"),
        help_row("PgUp / PgDn", "rola mais rápido"),
        help_row("Home / End", "topo / seguir o fim"),
        help_row("Enter", "detalhe do peer selecionado"),
        help_row("?", "esta ajuda"),
        help_row("q / Esc", "sai / fecha"),
        Line::from(""),
        Line::from(Span::styled(
            "  abas",
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "  jogadores: peers P2P da sessão (solo on: tentativas)",
            Style::default().fg(Color::Gray),
        )),
        Line::from(Span::styled(
            "  logs da rede: todo o tráfego cru do console",
            Style::default().fg(Color::Gray),
        )),
        Line::from(Span::styled(
            "  rodapé: tempo sozinho (solo off até o 1º player entrar)",
            Style::default().fg(Color::Gray),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "  cores",
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            Span::styled("  ● verde", Style::default().fg(Color::Green)),
            Span::raw(" ok / player  "),
            Span::styled("● vermelho", Style::default().fg(Color::Red)),
            Span::raw(" quebrado / datacenter"),
        ]),
        Line::from(vec![
            Span::styled("  ▲", Style::default().fg(ACTIVE)),
            Span::raw(" flood  "),
            Span::styled("←", Style::default().fg(Color::Red)),
            Span::raw(" tentativa de entrada"),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "  Esc fecha",
            Style::default().fg(Color::DarkGray),
        )),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" ajuda ");
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn kv(k: &str, v: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {k:<16} "), Style::default().fg(Color::DarkGray)),
        Span::styled(v.to_string(), Style::default().fg(Color::White)),
    ])
}
fn help_row(keys: &str, desc: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {keys:<14}"), Style::default().fg(Color::Cyan)),
        Span::styled(desc.to_string(), Style::default().fg(Color::Gray)),
    ])
}

/// A centered rect at `pw`%/`ph`% of `r`.
fn centered(pw: u16, ph: u16, r: Rect) -> Rect {
    let w = r.width * pw / 100;
    let h = r.height * ph / 100;
    Rect {
        x: r.x + (r.width - w) / 2,
        y: r.y + (r.height - h) / 2,
        width: w,
        height: h,
    }
}

fn fmt_dur(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{}h{:02}m", s / 3600, (s % 3600) / 60)
    }
}
fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}
fn is_game_endpoint(ep: &str) -> bool {
    match ep.rsplit('.').next().and_then(|p| p.parse::<u16>().ok()) {
        Some(p) => p == 6672 || (61455..=61458).contains(&p),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_follows_tail_and_clamps() {
        assert_eq!(window(100, 10, 0), (90, 90));
        assert_eq!(window(100, 10, 5), (85, 90));
        assert_eq!(window(100, 10, 999), (0, 90));
        assert_eq!(window(3, 10, 0), (0, 0));
    }

    #[test]
    fn game_endpoint_detection() {
        assert!(is_game_endpoint("192.168.1.250.61455"));
        assert!(is_game_endpoint("20.1.2.3.6672"));
        assert!(!is_game_endpoint("20.1.2.3.443"));
        assert!(!is_game_endpoint("notanip"));
    }

    #[test]
    fn strip_port_and_remote_ip() {
        assert_eq!(strip_port("192.168.1.250.52252"), "192.168.1.250");
        let row = NetRow {
            time: "10:00:00".into(),
            src: "192.168.1.250.52252".into(),
            dst: "20.1.2.3.443".into(),
            info: "tcp".into(),
        };
        assert_eq!(
            remote_ip(&row, "192.168.1.250"),
            Some("20.1.2.3".to_string())
        );
    }

    #[test]
    fn game_peer_extracts_remote_and_port() {
        let row = NetRow {
            time: "10:00:00".into(),
            src: "192.168.1.250.61455".into(),
            dst: "20.1.2.3.61455".into(),
            info: "udp".into(),
        };
        assert_eq!(
            game_peer(&row, "192.168.1.250"),
            Some(("20.1.2.3".to_string(), 61455))
        );
        // Non-game traffic yields nothing.
        let row2 = NetRow {
            time: "10:00:00".into(),
            src: "192.168.1.250.52252".into(),
            dst: "20.1.2.3.443".into(),
            info: "tcp".into(),
        };
        assert_eq!(game_peer(&row2, "192.168.1.250"), None);
    }

    #[test]
    fn endpoint_port_parsing() {
        assert_eq!(endpoint_port("20.1.2.3.6672"), 6672);
        assert_eq!(endpoint_port("notanip"), 0);
    }

    fn mk_session_peer(count: u64, ptr: Option<String>) -> SessionPeer {
        let now = Instant::now();
        SessionPeer {
            count,
            last: String::new(),
            ports: BTreeSet::new(),
            ptr,
            owner: String::new(),
            geo: String::new(),
            requested: false,
            since: now,
            last_seen: now,
        }
    }

    #[test]
    fn player_candidate_does_not_require_a_residential_ptr() {
        // Rockstar relay IP: never a player, even flooded.
        assert!(!mk_session_peer(100, None).is_player_candidate("192.81.245.10"));
        // Residential PTR: yes.
        assert!(mk_session_peer(10, Some("host.dynamic.vivo.com.br".into()))
            .is_player_candidate("20.1.2.3"));
        // Direct peer, enrichment done, no reverse DNS (the common console case):
        // still a player.
        assert!(mk_session_peer(50, Some(String::new())).is_player_candidate("20.1.2.3"));
        // Enrichment still pending (ptr None): wait, so a cloud relay is not
        // mistaken for a player before its PTR arrives.
        assert!(!mk_session_peer(50, None).is_player_candidate("20.1.2.3"));
        // Hosting PTR: never.
        assert!(
            !mk_session_peer(50, Some("ec2-1-2-3-4.compute.amazonaws.com".into()))
                .is_player_candidate("20.1.2.3")
        );
        // Too few packets: wait even when it looks like a player.
        assert!(!mk_session_peer(1, Some(String::new())).is_player_candidate("20.1.2.3"));
    }

    #[test]
    fn fill_timer_stops_only_with_a_player_after_solo_off() {
        // Solo off, timer running, a player showed up -> freeze.
        assert!(should_stop_fill(false, true, false, true));
        // No player yet -> keep running.
        assert!(!should_stop_fill(false, true, false, false));
        // Already frozen -> do not overwrite.
        assert!(!should_stop_fill(false, true, true, true));
        // Solo on, or never started -> nothing to measure.
        assert!(!should_stop_fill(true, true, false, true));
        assert!(!should_stop_fill(false, false, false, true));
    }

    #[test]
    fn trunc_keeps_short_strings() {
        assert_eq!(trunc("abc", 10), "abc");
        assert_eq!(trunc("abcdefghij", 5), "abcd…");
    }
}
