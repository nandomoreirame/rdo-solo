# rdo-solo-tui

Porte em Rust do `homelab/rdo-solo`: um binário único que roda **no
homelab** e faz duas coisas.

- **Sem argumento**: abre a TUI (ratatui) com abas, toggle de solo (tecla + botão
  + mouse) e o painel de tentativas de entrada.
- **Com subcomando**: roda headless (`on`, `off`, `status`, `boot`, `install`,
  `uninstall`, `nat-on`, `nat-off`, `route-fix`, `route-unfix`), então o serviço
  do systemd e scripts continuam funcionando.

Toda a lógica de firewall (cadeia `RDO_SOLO`, hook no `DOCKER-USER`, `ip rule
5200` que tira o console da tabela 52 do Tailscale, `send_redirects=0`, cadeia
log-then-drop) é a mesma do shell, portada 1:1. Armadilhas em `../homelab/rdo-solo.md`.

## Abas

Ordem: `jogadores na sessão · histórico · logs da rede · status`.

- **jogadores na sessão**
  - solo desligado: os **peers P2P** com quem o console fala nas portas do jogo
    (quem está na sua sessão), com IP, **local** (GeoIP), tipo
    (player/datacenter/Rockstar), provedor (whois), pkts, tempo na sessão e
    portas. `↑↓` seleciona, `Enter` abre o **detalhe**.
  - solo ligado: **tabela de tentativas** ordenada por ameaça, com IP, local,
    tipo, score, pkts, atividade em 10s, direção, portas. `▲` marca flood.
- **histórico**: tentativas gravadas em `/var/lib/rdo-solo/history.log`,
  persistem entre sessões (responde "quem me bateu ontem").
- **logs da rede**: todo o tráfego do console via `tcpdump` (P2P do jogo em
  verde), **sempre cru**, mesmo com solo ligado.
- **status**: estado, pré-requisitos de rota e contadores.

Header: selo de estado, botão de solo, IP do console, resumo da sessão
(uptime, total, IPs), **saúde da rota**
(forward/redirect/rota/console em verde/vermelho) e avisos ativos:
IP do console divergente, console sem passar pelo homelab, **Xbox com IPv6**
(fura o filtro IPv4). Quando solo está ligado: **sparkline de bloqueios/s** e
bordas laranja. Ao sair, imprime um resumo da sessão.

No rodapé, à direita, o **`Tempo sozinho na sessão:`**: começa a contar quando
você desliga o solo e congela (verde) no instante em que o **primeiro player**
entra na sessão. "Player" aqui é o primeiro peer P2P direto que não é relay da
Rockstar nem datacenter (não depende de PTR reverso, que a maioria dos consoles
não tem). Só aparece com o solo desligado; com solo ligado, esse canto mostra o
resumo da sessão solo.

Teclas: `Tab`/setas abas · `1..4` vai direto · `s` solo · `↑↓` seleciona/rola ·
`PgUp/PgDn` · `Home/End` · `Enter` detalhe · `?` ajuda · `q` sai. Mouse: roda
rola, clique liga/desliga no botão e troca de aba. A tela de resumo (ao desligar
o solo) fecha só com **tecla**, nunca com o mouse, então dá pra selecionar e
copiar o texto.

## Config (`/etc/rdo-solo.conf`)

Além de `CONSOLE_IP` e `WAN_IF`, chaves opcionais:

- `CONSOLE_MAC=aa:bb:cc:...`, habilita a detecção de IP divergente e de IPv6 do
  console; compara o IP vivo pelo MAC).
- `NTFY_URL=https://ntfy.sh/seu-topico`, push no celular quando um IP vira
  ameaça ALTA (via `curl`; sem a chave, não notifica).
- `GEOIP_DB=/var/lib/rdo-solo/GeoLite2-City.mmdb`, caminho do banco MaxMind
  GeoLite2 City para a coluna **local** ("Cidade, CC"). Opcional: se ausente, a
  TUI só omite o local. Sem essa chave, procura em
  `/var/lib/rdo-solo/GeoLite2-City.mmdb` e `/usr/share/GeoIP/`.

Dependências opcionais no homelab:

- `apt install whois` habilita a coluna "provedor" (ASN via whois). Sem whois, a
  classificação usa só o PTR (degrada em silêncio).
- **GeoIP**: baixe `GeoLite2-City.mmdb` (conta grátis em
  [maxmind.com](https://www.maxmind.com/en/geolite2/signup)) e aponte
  `GEOIP_DB=` para ele. O banco não é versionado (licença). É lido por um crate
  puro-Rust, então o binário musl continua estático.

## Build e deploy

Build estático com musl (`x86_64-unknown-linux-musl`), para rodar no Ubuntu do
homelab sem depender da versão de glibc.

```bash
./deploy.sh                 # compila aqui e instala em /usr/local/bin/rdo-solo-tui
sudo rdo-solo-tui           # no homelab
```

Usa as mesmas cadeias iptables e o mesmo `/var/lib/rdo-solo/state` do script
shell, então `rdo-solo-tui on/off` e `rdo-solo on/off` são intercambiáveis.
`sudo rdo-solo-tui install` faz o binário assumir o systemd unit; nada é
destrutivo antes disso.
