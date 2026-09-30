# rdo-solo-web

Painel web de bolso para ligar/desligar o **modo solo** do celular, pela rede
interna ou pelo Tailscale. Roda **no gateway** (mesma máquina do `rdo-solo`).

- **Toggle** grande de LIGAR/DESLIGAR o filtro P2P.
- **Status ao vivo** por WebSocket: solo on/off, há quanto tempo, bloqueios, IPs
  distintos e a saúde da rota (encaminhamento, redirecionamentos, rota, console).
- **PIN** de acesso + sessão assinada (cookie httpOnly), com rate-limit.
- **Detecção de queda de sessão**: autodesligamento do solo + alerta no Discord.

## Arquitetura

Next.js (App Router) servido por um **custom server Node** (`server.ts`) que
hospeda o WebSocket na mesma porta (o App Router não faz WS sozinho). O painel
não mexe em rede direto: ele chama o binário `rdo-solo-tui` do gateway.

```
celular ──HTTP/WS──> server.ts (Next + ws) ──sudo──> rdo-solo-tui on|off|status --json
                                        └──> journalctl -k (conta bloqueios/IPs ao vivo)
```

- `src/lib/` concentra a lógica testada: sessão/PIN (`session.ts`), rate-limit,
  parse do status (`status.ts`), o executor (`rdo.ts`) e o monitor (`monitor.ts`).
- `src/app/api/` tem `auth` (valida PIN → cookie), `solo` (on/off) e `status`.
- O status estruturado vem de `rdo-solo-tui status --json` (adicionado no `tui/`).

## Configuração

```bash
cp .env.example .env.local
# edite .env.local:
#   RDO_PIN=um-pin-so-seu
#   RDO_SESSION_SECRET=$(openssl rand -hex 32)
#   RDO_BIND=0.0.0.0        # 0.0.0.0 = LAN + Tailscale; ou o IP 100.x p/ só tailnet
#   PORT=3737
```

`.env.local` é gitignored — o PIN e o segredo **nunca** são commitados.

## Pré-requisitos no gateway

1. `rdo-solo-tui` instalado em `/usr/local/bin` (com o subcomando `status --json`).
2. **sudoers** para o usuário do serviço acionar o filtro sem senha:
   ```bash
   sudo install -m 0440 systemd/rdo-solo-web.sudoers /etc/sudoers.d/rdo-solo-web
   sudo visudo -c
   ```
   (troque `CHANGE_ME` pelo usuário do serviço).
3. Leitura do journal (para contar bloqueios ao vivo), sem sudo:
   ```bash
   sudo usermod -aG systemd-journal <user>
   ```

## Build e execução

```bash
npm install
npm run build          # next build
npm run start          # custom server em produção (tsx server.ts)
# dev: npm run dev
```

Como serviço systemd (mais limpo, roda direto no host):

```bash
sudo cp systemd/rdo-solo-web.service /etc/systemd/system/
# edite User/WorkingDirectory/ExecStart, depois:
sudo systemctl enable --now rdo-solo-web
```

### Docker / CasaOS

O app controla o **firewall do host**, então o container precisa de
`network_mode: host` + `privileged` e do binário/estado do host montados (o
Docker não isola de verdade aqui; o systemd acima é mais simples). Arquivos:
`Dockerfile`, `.dockerignore`, `docker-compose.yml`.

```bash
# no homelab, com o web/ copiado e o rdo-solo-tui já instalado:
docker build -t rdo-solo-web:latest .
```

No CasaOS: **Apps → + → Install a customized app** e importe o `docker-compose.yml`.
Antes de subir, troque `RDO_PIN` e `RDO_SESSION_SECRET` (não commite os reais).
Os contadores de bloqueio ficam em 0 no container por padrão; para tê-los,
adicione `systemd` ao `apt install` do Dockerfile e monte o journal do host
(comentários no compose). O toggle, o status e a saúde da rota funcionam sem isso.

## Acesso pelo celular

- **LAN:** `http://<ip-do-gateway>:3737` (ou um hostname via Pi-hole).
- **Tailscale:** `http://<nome-ou-ip-tailscale>:3737` de qualquer lugar.

Para aceitar **só** pela tailnet, ponha `RDO_BIND` no IP `100.x.y.z` do gateway.

## Segurança

- PIN comparado em tempo constante; sessão via HMAC (sem banco).
- Rate-limit de 5 tentativas de PIN por minuto por IP.
- O servidor roda sem privilégio; só o `rdo-solo-tui` sobe via sudo restrito.
- Servido em HTTP na rede interna. Atrás de TLS, marque o cookie como `secure`
  em `src/app/api/auth/route.ts`.

## Detecção de queda de sessão

O painel detecta quando o Red Dead Online te desconecta ("perdeu conexão com os
serviços da Rockstar"). Não lê o código de erro do jogo (criptografado); infere
pela rede: o console mantém tráfego constante com a rede de serviços da Rockstar
(RSONET, `192.81.240.0/21`) enquanto conectado, e esse tráfego cessa na queda.
Funciona **mesmo com o solo ligado** (o filtro bloqueia só o P2P; os serviços da
Rockstar seguem até a sessão cair).

Ao detectar a queda:

- **Autodesligamento** (`RDO_AUTO_OFF=1`): desliga o solo sozinho, porque com ele
  ligado o filtro impede a reconexão.
- **Discord** (`RDO_DISCORD_WEBHOOK`): manda o alerta no webhook do seu canal.
- **Painel**: mostra um aviso "SESSÃO CAIU".

Ajuste `RDO_DROP_SILENCE_SECS` (silêncio que conta como queda) e
`RDO_DROP_CONFIRM_SECS` (tráfego mínimo pra confirmar uma sessão real). É uma
heurística: bom proxy, não infalível. Requer `tcpdump` na imagem (já incluído) e
rede do host (o container roda com `network_mode: host`).

## Testes

```bash
npm test          # vitest (lógica de sessão, rate-limit, status, parse de log)
npm run typecheck # tsc --noEmit
```
