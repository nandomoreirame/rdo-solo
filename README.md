# rdo-solo

Controlador de sessão **solo** do Red Dead Online (e GTA Online): bloqueia o
tráfego peer-to-peer do jogo no **gateway** por onde o console passa, deixando
você sozinho na sessão sem depender do "tic-tac" (o interruptor físico no cabo
de rede).

## Como funciona

O console (Xbox) fica **cabeado atrás de um gateway Linux** que você controla
(um homelab, um mini-PC ou um Raspberry Pi). Todo o tráfego do console passa por
esse gateway. Com o modo solo ligado, o gateway derruba as portas UDP que o jogo
usa para as conexões P2P (6672 e 61455-61458), então nenhum outro jogador entra
na sua sessão. Missões e séries do bando continuam funcionando (são privadas do
bando); só o Free Roam público fica vazio.

Isso **não** funciona num PC comum que não esteja no caminho do tráfego do
console: o valor está na topologia (gateway), não no binário.

## Estrutura

| Pasta | O que é |
|---|---|
| `homelab/rdo-solo` | script shell que roda no gateway; mexe em iptables e rota. |
| `homelab/rdo-solo.md` | documentação detalhada: topologia, comandos, armadilhas, termos de uso. |
| `workstation/rdo-solo` | wrapper que você digita na sua máquina; leva o comando por SSH e roda sob `sudo` no gateway. |
| `tui/` | porte em Rust: uma TUI (ratatui) com abas de rede, toggle de solo, jogadores na sessão, GeoIP e histórico. Ver `tui/README.md`. |
| `web/` | painel web (Next.js + WebSocket) para ligar/desligar o solo do celular, pela LAN ou Tailscale. Ver `web/README.md`. |

## Requisitos

- Um **gateway Linux** por onde o console roteia (forwarding + NAT).
- `iptables`, `iproute2` e, para a TUI, `tcpdump`. `whois` e um banco MaxMind
  GeoLite2 City são opcionais e apenas enriquecem os IPs.
- Root no gateway (as regras de firewall exigem).

## Uso rápido

Shell, no gateway:

```bash
sudo ./homelab/rdo-solo on      # liga o bloqueio P2P
sudo ./homelab/rdo-solo off     # desliga
./homelab/rdo-solo status       # estado (não pede senha)
```

TUI:

```bash
cd tui && ./deploy.sh           # compila estático (musl) e instala no gateway
sudo rdo-solo-tui               # abre a interface no gateway
```

O `deploy.sh` compila aqui e envia por SSH; o host de destino sai de
`RDO_HOMELAB_HOST` (padrão `homelab`). A configuração de runtime
(`/etc/rdo-solo.conf`: `CONSOLE_IP`, `WAN_IF`, `GEOIP_DB`, `NTFY_URL`) está
documentada em `tui/README.md`.

## Aviso

Bloquear o tráfego do jogo mexe na sua conexão com os servidores e com outros
jogadores. Use por sua conta e risco e leia a seção "Termos de uso" em
`homelab/rdo-solo.md`. Esta é uma ferramenta pessoal, extraída de um dotfiles
privado e compartilhada como está.
