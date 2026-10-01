# Spec: Squad Mode (allowlist de sessão + expulsar outros)

## Problem Statement

Em lobby público de Red Dead Online, players maliciosos atacam e você quer purgar
a sessão mantendo só você + amigos. Um whitelist anterior (subcomandos
`allow`/`posse`) foi removido em 28/09/2026 porque derrubava o **host** da sessão
(quase sempre um estranho) e os **relays da Rockstar** junto com os estranhos,
matando a sessão na próxima migração de host (erro `0x50060190`). Esta feature
refaz o allowlist corrigindo essa falha: captura os peers da sessão atual em um
clique e, ao ativar "expulsar outros", dropa todo P2P fora do squad **sempre
preservando os relays (RSONET)**, assumindo você como host da sessão limpa.

## Goals

- Capturar os IPs dos peers ativos da sessão em **1 ação** e salvar como squad (replace).
- Ativar um modo que dropa todo P2P fora do squad **sem nunca tocar nos relays da Rockstar**.
- Validar o modo numa sessão real (você + 1 amigo sobrevivem à ativação e à migração de host) antes de considerar pronto.

## Context

O `rdo-solo` controla sessões solo de RDO dropando o P2P do jogo (UDP 6672 e
61455-61458) no gateway Linux por onde o console passa. Hoje o drop é
**tudo-ou-nada por porta**: a chain `RDO_SOLO` casa apenas `CONSOLE_IP` + portas
do jogo, sem olhar o IP do peer. Existem três superfícies que compartilham estado
só por arquivos em `/var/lib/rdo-solo/`: o script shell (`homelab/rdo-solo`), o
binário Rust (`tui/`, que é o que o painel web realmente invoca via `RDO_BIN`) e o
painel web Next.js (`web/`), que já captura os peers da sessão via `tcpdump` mas
**esconde os relays da Rockstar de propósito** (pra poder fazer o solo). É
exatamente essa exclusão que fez o `posse` falhar: a captura pega os amigos, nunca
o host nem os relays.

## Verified Claims

| Claim | Source (file:line) | Verified |
|-------|--------------------|----------|
| Drop é por porta, sem match de peer IP (`load_drops` casa só console + portas) | `homelab/rdo-solo:140` | yes |
| Mesmo drop por porta no binário Rust (1:1 com o shell) | `tui/src/firewall.rs:176` | yes |
| Estado persistido é texto puro `on`/`off` | `homelab/rdo-solo:29`, `tui/src/firewall.rs:222` | yes |
| Monitor web exclui RSONET da lista de peers (`inNets` → skip) | `web/src/lib/monitor.ts:270` | yes |
| Faixas RSONET default (env `RDO_RSONET_NETS`) | `web/src/lib/monitor.ts:32` | yes |
| `snapshot()` expõe a lista viva de peers (PanelPeer[]) | `web/src/lib/monitor.ts:164` | yes |
| TTL da lista viva de peers = 90s | `web/src/lib/monitor.ts:26` | yes |
| Shape `PanelPeer { ip, count, country, cc, last_seen }` | `web/src/lib/status.ts:35` | yes |
| Web dispara ação no host via `execFile` do binário (`toggleSolo`) | `web/src/lib/rdo.ts:18` | yes |
| API só aceita `on`/`off` hoje | `web/src/app/api/solo/route.ts:19` | yes |
| Binário invocado é `rdo-solo-tui` (`RDO_BIN`) | `web/src/lib/config.ts:48` | yes |
| Sudoers só permite `on`/`off`/`status --json` | `web/systemd/rdo-solo-web.sudoers:9` | yes |
| Dispatch de subcomandos (Rust) | `tui/src/main.rs:54` | yes |
| Dispatch de subcomandos (shell) | `homelab/rdo-solo:378` | yes |
| Post-mortem: whitelist derruba host/relays → morre na migração | `homelab/rdo-solo.md:103`, `homelab/rdo-solo.md:112` | yes |
| Docker roda root + host network + monta `/var/lib/rdo-solo` RW (`RDO_SUDO=0`) | `web/docker-compose.yml` | yes |
| Squad sobrevive se manter RSONET + virar host | n/a (hipótese de comportamento; validar ao vivo no REQ-011) | assumption |

## Requirements

### P1 (MVP)

1. **[REQ-001]** QUANDO o usuário clica "Capturar esquadrão" ENTÃO o sistema DEVE sobrescrever por completo o `squad.list`, gravando somente os IPs dos peers ativos naquele momento (lista viva do monitor) e descartando qualquer IP de capturas anteriores.
2. **[REQ-002]** QUANDO a captura conclui ENTÃO o sistema DEVE exibir os IPs salvos (com país/GeoIP) e o horário da captura, para conferência.
3. **[REQ-003]** QUANDO o modo Squad é ativado ENTÃO o sistema DEVE dropar o tráfego P2P (portas do jogo) de/para todo IP que NÃO está no `squad.list`.
4. **[REQ-004]** QUANDO o modo Solo OU Squad está ativo ENTÃO o sistema DEVE SEMPRE permitir o tráfego de/para as faixas da Rockstar (RSONET), para preservar host/relays e não derrubar a sessão inteira.
5. **[REQ-005]** QUANDO o modo Squad é desativado ENTÃO o sistema DEVE remover as regras de drop e restaurar o P2P normal.
6. **[REQ-006]** O sistema DEVE suportar três modos mutuamente exclusivos — Normal (sem drop), Solo (dropa todo P2P, inclusive relays) e Squad (dropa todo P2P exceto squad + relays) — persistidos no estado.
7. **[REQ-007]** QUANDO o `squad.list` está vazio e o usuário ativa o modo Squad ENTÃO o sistema DEVE avisar que isso expulsa todos os players (só os relays permanecem).
8. **[REQ-008]** QUANDO o usuário tenta capturar fora do modo Normal ENTÃO o sistema DEVE avisar, porque peer já dropado não aparece na captura.
9. **[REQ-009]** O painel web DEVE expor o botão Capturar, o toggle do modo Squad e a lista salva do squad (ver/limpar).
10. **[REQ-010]** QUANDO o binário recebe IPs por argumento (captura/set) ENTÃO o sistema DEVE validar que cada um é um IP bem-formado antes de usar na regra de firewall.
11. **[REQ-011]** O modo Squad DEVE ser validado numa sessão real (você + 1 amigo permanecem após a ativação e a migração de host) antes de ser considerado pronto.

### P2 (Should Have)

12. **[REQ-012]** O sistema DEVE oferecer paridade na TUI interativa (capturar / ativar Squad / ver lista).
13. **[REQ-013]** O usuário DEVE poder remover um IP individual do squad e limpar a lista.
14. **[REQ-014]** O sistema DEVE exibir a idade da captura e sugerir recaptura, já que IP de amigo rotaciona entre sessões.

### P3 (Nice to Have)

15. **[REQ-015]** O sistema DEVE permitir apelidos por IP no squad.
16. **[REQ-016]** O sistema DEVE oferecer uma blocklist (banir IP de atacante) como modo complementar.
17. **[REQ-017]** O binário DEVE suportar captura self-contained via `tcpdump`, além do envio da lista pelo web.

## Edge Cases

- **Squad vazio + ativar** - equivale a expulsar todos os players (só relays ficam); o sistema avisa (REQ-007), mas permite.
- **Captura fora do Normal** - peers já dropados não aparecem; a captura sairia incompleta; o sistema avisa (REQ-008).
- **IP de amigo rotaciona** - entre sessões o IP salvo pode não casar; recaptura por sessão é o fluxo normal; a idade da captura é exibida (REQ-014).
- **Dois players na mesma casa** - mesmo IP público; não dá pra separar amigo de estranho atrás do mesmo NAT.
- **Console em IPv6** - o allowlist é IPv4; se o P2P do console for por IPv6, as regras não pegam (constraint).
- **Um amigo já é o host** - a sessão sobrevive limpa, sem migração.
- **Migração de host falha** - risco residual: mesmo preservando relays, a troca de host pode desconectar você em lobby de estranho; é o motivo da validação ao vivo (REQ-011, assumption).

## Architecture Decisions

1. **Squad = Solo com exceções** - `load_drops` passa a inserir, quando o modo é `squad`, uma regra RETURN para cada IP do squad **e** para as faixas RSONET, ANTES dos DROP por porta. Solo mantém o comportamento atual (sem exceções, dropa até os relays). Alternativa descartada: uma chain nova separada — reusar `load_drops` mantém shell e Rust em paridade com menos superfície.
2. **Estado com três valores** - `/var/lib/rdo-solo/state` passa de `{off,on}` para `{off,solo,squad}`; `on` legado é lido como `solo`. Alternativa descartada: um flag separado pra squad — um único campo de modo evita estados inconsistentes.
3. **Lista em texto puro** - `squad.list` em `/var/lib/rdo-solo/`, um IP por linha + comentário `# captured_at=<iso>`. Sem serde (o binário evita serde pra ficar pequeno no musl). Alternativa descartada: JSON — não há JSON no host hoje e o Rust não usa serde.
4. **Binário Rust é a autoridade de escrita** - a captura pelo web envia os IPs do próprio monitor (`snapshot()`) para `rdo-solo-tui squad-set <ips>`, que valida e grava o arquivo. Alternativa descartada: o web escrever o arquivo direto — geraria corrida entre o processo web e o Rust.
5. **Docker dispensa sudoers no MVP** - o deploy roda root com `RDO_SUDO=0`, então novos subcomandos funcionam sem tocar no sudoers; o update de sudoers fica só para o install bare-metal (fora do MVP).
6. **Captura substitui** - replace, não acumula (REQ-001).
7. **"Ativo no momento" = lista viva** - o conjunto capturado é o snapshot vivo do monitor (`PEER_TTL_MS=90s`), sem filtro extra de janela.

## Grilling Log

| # | Decision | Resolution | Rationale |
|---|----------|------------|-----------|
| 1 | A ideia "capturar peers e expulsar o resto" é nova? | Não — era o `allow`/`posse`, removido em 28/09 por derrubar host/relays | Evita reimplementar uma falha conhecida |
| 2 | Como não repetir a falha do `posse`? | SEMPRE manter RSONET liberado (REQ-004) e assumir você como host | O que faltou no `posse` foi preservar os relays |
| 3 | Direção: blocklist cirúrgica ou squad allowlist? | Squad allowlist corrigido + validação ao vivo (escolha do usuário) | É o cenário real: purgar o lobby mantendo o grupo |
| 4 | Captura: replace ou append? | Replace — só os ativos no momento | Snapshot da sessão atual, descarta sessões antigas |
| 5 | O que é "ativo no momento"? | Lista viva do monitor (TTL 90s), sem filtro extra | Reusa o que já existe, menos código |
| 6 | Quem escreve a lista? | O binário Rust (via `squad-set`), web manda os IPs | Evita corrida entre web e Rust |
| 7 | Enforcement por IP existe hoje? | Não (só por porta); adicionar RETURN por IP em `load_drops` | Base para o allowlist |
| 8 | Blocklist no MVP? | Não — P3 | Foco no pedido; infra de regra por-IP é compartilhada depois |

## Constraints

- IPv4 apenas (ip6tables fora de escopo).
- A confiabilidade do "expulsar" depende de você virar host; a migração pode, raramente, desconectar — por isso a validação ao vivo (REQ-011).
- Shell (`homelab/rdo-solo`) e Rust (`tui/src/firewall.rs`) mudam em paridade 1:1.
- Sem serde no binário Rust.
- IPs vindos do web são input não confiável na ponte privilegiada; validar server-side antes do `execFile`/`iptables` (REQ-010).

## Out of Scope

| Item | Reason |
|------|--------|
| Blocklist de atacantes | Outra direção; vira P3/depois (REQ-016) |
| Sessão só-amigos nativa do jogo | Não é filtro de rede |
| IPv6 / ip6tables | Console atual é IPv4 |
| Apelidos / múltiplos perfis de squad | P3 (REQ-015) |
| Correção do NAT duplo (Vivo Box) | Assunto separado, em aberto |

## Test Strategy

- **Unit (web/TS):** validação de IP; parse/format do `squad.list`; regra "capturar só em Normal"; `inNets` para RSONET; shape da ação de captura.
- **Unit (Rust):** `load_drops` gera os RETURN corretos (squad + RSONET) antes dos DROP; round-trip do estado `{off,solo,squad}`; parser/serializador do `squad.list`; validação de IP em `squad-set`.
- **Integration:** `squad-set <ips>` grava o arquivo; `squad-on` aplica (conferir `iptables -S RDO_SOLO`); `squad-off` limpa; modo persiste no boot.
- **E2E / ao vivo (REQ-011):** sessão real com 1 amigo — capturar em Normal, ativar Squad, confirmar que você + amigo permanecem e os outros saem; observar a migração de host.

## Requirement Traceability

| ID | Description | Priority | Status |
|----|-------------|----------|--------|
| REQ-001 | Capturar sobrescreve o squad.list com os peers ativos | P1 | Pending |
| REQ-002 | Exibir IPs salvos (GeoIP) e horário da captura | P1 | Pending |
| REQ-003 | Modo Squad dropa P2P fora do squad | P1 | Pending |
| REQ-004 | Solo/Squad sempre preservam RSONET | P1 | Pending |
| REQ-005 | Desativar Squad restaura o P2P | P1 | Pending |
| REQ-006 | Três modos Normal/Solo/Squad persistidos | P1 | Pending |
| REQ-007 | Avisar squad vazio = expulsa todos | P1 | Pending |
| REQ-008 | Avisar captura fora do Normal | P1 | Pending |
| REQ-009 | Web expõe capturar/toggle/lista | P1 | Pending |
| REQ-010 | Validar IPs recebidos por argumento | P1 | Pending |
| REQ-011 | Validação ao vivo (você + amigo sobrevivem) | P1 | Pending |
| REQ-012 | Paridade na TUI interativa | P2 | Pending |
| REQ-013 | Remover IP / limpar lista | P2 | Pending |
| REQ-014 | Exibir idade da captura / sugerir recaptura | P2 | Pending |
| REQ-015 | Apelidos por IP | P3 | Pending |
| REQ-016 | Blocklist de atacantes | P3 | Pending |
| REQ-017 | Captura self-contained no binário | P3 | Pending |
