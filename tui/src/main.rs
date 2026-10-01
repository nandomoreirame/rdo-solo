//! rdo-solo-tui - solo Red Dead Online session controller.
//!
//! With no argument it launches the TUI. With a subcommand it runs headless, so
//! the systemd unit (`... boot`) and scripting keep working. Runs on the homelab
//! and needs root for the iptables/routing subcommands.

mod alert;
mod app;
mod classify;
mod config;
mod firewall;
mod geo;
mod history;
mod netlog;
mod score;
mod squad;

use anyhow::Result;
use app::{ui, App};
use config::Config;
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
    MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(String::as_str).unwrap_or("tui");

    let code = match run(sub) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn need_root() -> Result<()> {
    if !firewall::is_root() {
        anyhow::bail!("must run as root (use sudo)");
    }
    Ok(())
}

fn run(sub: &str) -> Result<()> {
    let cfg = Config::load();
    match sub {
        "tui" => {
            need_root()?;
            run_tui(cfg)
        }
        "on" => {
            need_root()?;
            firewall::cmd_on(&cfg)?;
            println!(
                "solo ON for {} (udp {}, {})",
                cfg.console_ip,
                config::GAME_PORT_SINGLE,
                config::GAME_PORT_RANGE
            );
            println!("  para jogar em bando use 'off' (missões/séries já são privadas do bando)");
            Ok(())
        }
        "off" => {
            need_root()?;
            firewall::cmd_off(&cfg)?;
            println!("solo OFF (console plays normally)");
            Ok(())
        }
        "status" => {
            // `status --json` feeds the web control panel; plain `status` stays
            // human-readable for the CLI.
            if std::env::args().any(|a| a == "--json") {
                print_status_json(&cfg);
            } else {
                for l in firewall::status_lines(&cfg) {
                    println!("{l}");
                }
            }
            Ok(())
        }
        "boot" => {
            need_root()?;
            firewall::cmd_boot(&cfg)
        }
        "install" => {
            need_root()?;
            firewall::cmd_install(&cfg)?;
            println!(
                "install done. filter is currently: {}",
                firewall::read_state()
            );
            Ok(())
        }
        "uninstall" => {
            need_root()?;
            firewall::cmd_uninstall(&cfg)?;
            println!("uninstalled. conf and state kept.");
            Ok(())
        }
        "nat-on" => {
            need_root()?;
            firewall::cmd_nat_on(&cfg)?;
            println!("masquerade ON for {}", cfg.console_ip);
            Ok(())
        }
        "nat-off" => {
            need_root()?;
            firewall::cmd_nat_off()?;
            println!("masquerade OFF");
            Ok(())
        }
        "route-fix" => {
            need_root()?;
            firewall::route_fix(&cfg)?;
            println!(
                "ip rule {} applied for {}",
                config::RULE_PRIO,
                cfg.console_ip
            );
            Ok(())
        }
        "route-unfix" => {
            need_root()?;
            firewall::route_unfix(&cfg)?;
            println!("ip rule {} removed", config::RULE_PRIO);
            Ok(())
        }
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            anyhow::bail!("unknown command");
        }
    }
}

/// Emit the current state and route health as a single JSON line. Written by
/// hand (no serde) to keep the static musl binary small; every value is a bool,
/// an integer, or an IP string with no characters that need escaping.
fn print_status_json(cfg: &Config) {
    let state = firewall::read_state();
    let solo = state == "on";
    let h = firewall::health(cfg);
    let since = std::fs::metadata(config::STATE_FILE)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let since_json = match since {
        Some(s) => s.to_string(),
        None => "null".to_string(),
    };
    let label = cfg
        .console_label
        .as_deref()
        .unwrap_or("")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    println!(
        "{{\"solo\":{solo},\"state\":\"{state}\",\"since_epoch\":{since_json},\
         \"console_ip\":\"{ip}\",\"console_label\":\"{label}\",\
         \"health\":{{\"forwarding\":{fwd},\"redirects_ok\":{red},\
         \"route_rule\":{rr},\"console_present\":{cp},\"ip_mismatch\":{mm},\
         \"console_ipv6\":{v6},\"gateway_pkts\":{gp},\"ok\":{ok}}}}}",
        ip = cfg.console_ip,
        fwd = h.forwarding,
        red = h.redirects_ok,
        rr = h.route_rule,
        cp = h.console_present,
        mm = h.ip_mismatch,
        v6 = h.console_ipv6,
        gp = h.gateway_pkts,
        ok = h.ok(),
    );
}

fn print_help() {
    println!(
        "rdo-solo-tui — sessão solo do Red Dead Online (roda no homelab)\n\n\
         sem argumento         abre a TUI (tabs de rede, toggle solo, tentativas)\n\
         on | off              liga/desliga o bloqueio P2P\n\
         status [--json]       estado e pré-requisitos de rota (--json p/ o painel web)\n\
         boot                  reaplica no boot (usado pelo systemd)\n\
         install | uninstall   instala/remove o serviço e as regras\n\
         nat-on | nat-off      masquerade do console (fallback)\n\
         route-fix | route-unfix   ip rule 5200 (escape da tabela 52 do Tailscale)\n"
    );
}

fn run_tui(cfg: Config) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(cfg);
    let res = event_loop(&mut terminal, &mut app);
    let summary = app.session_summary();

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    // Session recap, printed after the alternate screen is gone.
    if let Some(s) = summary {
        println!("{s}");
    }
    res
}

fn event_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
) -> Result<()> {
    // Mouse capture is released while the recap screen is up, so the terminal
    // handles selection/clicks natively: the user can select text and click
    // without the screen closing (only a key dismisses it).
    let mut mouse_captured = true;
    loop {
        app.drain();
        terminal.draw(|f| ui(f, app))?;

        // Toggle mouse capture on stdout directly: event_loop is generic over the
        // backend, which is not Write, so execute! cannot target it here.
        let want_capture = app.recap.is_none();
        if want_capture != mouse_captured {
            if want_capture {
                execute!(io::stdout(), EnableMouseCapture)?;
            } else {
                execute!(io::stdout(), DisableMouseCapture)?;
            }
            mouse_captured = want_capture;
        }

        if event::poll(Duration::from_millis(200))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => handle_key(app, key),
                Event::Mouse(m) => handle_mouse(app, m),
                _ => {}
            }
        }

        app.tick();
        if app.should_quit {
            break;
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, key: crossterm::event::KeyEvent) {
    // The closing screen swallows any key: it just returns to the logs.
    if app.recap.is_some() {
        app.dismiss_recap();
        return;
    }
    // Overlays capture Esc/q first, so they close instead of quitting.
    let overlay = app.detail.is_some() || app.show_help;
    match key.code {
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.should_quit = true
        }
        KeyCode::Esc if overlay => app.close_overlays(),
        KeyCode::Char('q') | KeyCode::Esc => app.should_quit = true,
        KeyCode::Char('?') => app.toggle_help(),
        KeyCode::Char('s') => app.toggle_solo(),
        KeyCode::Enter => app.open_detail(),
        KeyCode::Tab | KeyCode::Right => app.next_tab(),
        KeyCode::BackTab | KeyCode::Left => app.prev_tab(),
        KeyCode::Char('1') => app.set_tab(0),
        KeyCode::Char('2') => app.set_tab(1),
        KeyCode::Char('3') => app.set_tab(2),
        KeyCode::Char('4') => app.set_tab(3),
        KeyCode::Up | KeyCode::Char('k') => app.nav_up(),
        KeyCode::Down | KeyCode::Char('j') => app.nav_down(false),
        KeyCode::PageUp => app.page_up(),
        KeyCode::PageDown => app.nav_down(true),
        KeyCode::Home | KeyCode::Char('g') => app.scroll_top(),
        KeyCode::End | KeyCode::Char('G') => app.scroll_follow(),
        _ => {}
    }
}

fn handle_mouse(app: &mut App, m: crossterm::event::MouseEvent) {
    // While the recap is up, mouse capture is off, so events rarely arrive here;
    // if any do, ignore them so a click never closes the screen.
    if app.recap.is_some() {
        return;
    }
    match m.kind {
        MouseEventKind::ScrollUp => app.nav_up(),
        MouseEventKind::ScrollDown => app.nav_down(false),
        MouseEventKind::Down(MouseButton::Left) => {
            if in_rect(m.column, m.row, app.button_rect) {
                app.toggle_solo();
            } else if in_rect(m.column, m.row, app.tabs_rect) {
                app.next_tab();
            }
        }
        _ => {}
    }
}

fn in_rect(x: u16, y: u16, r: ratatui::layout::Rect) -> bool {
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}
