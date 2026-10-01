# Spec: Painel responsivo (controles no centro, info à direita/drawer)

## Problem Statement

O painel do rdo-solo indica o estado solo de forma redundante (botão
LIGAR/DESLIGAR + rótulo "SOLO ATIVO/INATIVO" + "jogando normalmente" + uptime) e
empilha tudo numa coluna única centralizada. O usuário quer um layout mais limpo
e responsivo: só os botões no centro (estado por cor/borda), com as informações
gerais num painel à direita (desktop/tablet) ou numa gaveta (mobile).

## Goals

- Remover os rótulos redundantes de estado; estado fica por cor/borda + texto do botão.
- Centralizar só os controles (botões + uptime/sozinho discreto).
- Layout responsivo: info à direita no desktop/tablet, drawer no mobile.
- "modo limpo" vira o toggle do painel (recolhe à direita / abre o drawer).

## Context

O painel é um Client Component Next.js (`web/src/app/page.tsx`) que recebe o
`status` por WebSocket e renderiza tudo numa `<main className="wrap">` de coluna
única. O bloco de informações já está isolado atrás de `{!clean && (...)}` (squad
salvo, métricas, peers, health). O toggle "modo limpo" (`clean`) persiste em
`localStorage` e hoje só esconde esse bloco. Os estilos estão em
`web/src/app/globals.css`. Esta mudança é só de apresentação — não toca em API,
monitor, binário ou dados.

## Verified Claims

| Claim | Source (file:line) | Verified |
|-------|--------------------|----------|
| Container de coluna única `.wrap` | `web/src/app/page.tsx:329` | yes |
| Bloco de info atrás de `{!clean && (...)}` | `web/src/app/page.tsx:412` | yes |
| Card de controle (solo/squad) | `web/src/app/page.tsx:345` | yes |
| Rótulo redundante "SOLO ATIVO/INATIVO" | `web/src/app/page.tsx:358` | yes |
| Subtítulo "jogando normalmente" / "há X" | `web/src/app/page.tsx:360` | yes |
| "Tempo sozinho na sessão" | `web/src/app/page.tsx:364` | yes |
| squad-controls (MODO SQUAD + Capturar) | `web/src/app/page.tsx:379` | yes |
| Métricas (bloqueios / IPs distintos) | `web/src/app/page.tsx:453` | yes |
| Peers ("tentando entrar"/"na sua sessão") | `web/src/app/page.tsx:464` | yes |
| Health (encaminha/redirec/rota/console) | `web/src/app/page.tsx:483` | yes |
| Toggle `clean` persistido em localStorage | `web/src/app/page.tsx:28` | yes |
| Estilos do painel (.wrap/.card/.solo-frame/.peerlist/.clean-toggle/.grid) | `web/src/app/globals.css` | yes |

## Requirements

### P1 (MVP)

1. **[REQ-001]** QUANDO o painel renderiza ENTÃO o sistema DEVE remover os rótulos redundantes ("SOLO ATIVO/SQUAD ATIVO/SOLO INATIVO" e "jogando normalmente"), deixando o estado indicado pela cor/borda e pelo texto do botão (LIGAR/DESLIGAR).
2. **[REQ-002]** QUANDO solo/squad está ativo ENTÃO o sistema DEVE mostrar o uptime ("há Xs") de forma discreta junto aos botões; QUANDO off e sozinho ENTÃO DEVE mostrar o "tempo sozinho" discreto junto aos botões.
3. **[REQ-003]** O centro da tela DEVE conter apenas os controles (botão Solo, botão Squad, botão Capturar e o uptime/sozinho discreto); nenhuma métrica ou lista fica no centro.
4. **[REQ-004]** QUANDO a largura ≥ breakpoint (desktop/tablet) ENTÃO as informações gerais (squad salvo, bloqueios, IPs distintos, peers, health) DEVEM ficar num painel à direita, ao lado dos controles.
5. **[REQ-005]** QUANDO a largura < breakpoint (mobile) ENTÃO o centro DEVE ser os botões e as informações gerais DEVEM ficar numa gaveta (drawer) que desliza da lateral, aberta por um botão e fechada tocando fora ou no X.
6. **[REQ-006]** O "modo limpo" DEVE virar o toggle do painel: no desktop recolhe/expande o painel à direita; no mobile é o botão que abre/fecha o drawer.
7. **[REQ-007]** O estado do painel (aberto/recolhido) DEVE persistir por viewer em localStorage.
8. **[REQ-008]** A borda de ativo (solo-frame) e as cores dos botões DEVEM continuar indicando o estado.
9. **[REQ-009]** O cabeçalho (rdo-solo + console) e o indicador "ao vivo" DEVEM permanecer.

### P2 (Should Have)

10. **[REQ-010]** O drawer DEVE ter transição suave (slide), fechar no Esc e manter trap de foco (a11y).
11. **[REQ-011]** A faixa de tablet DEVE se adaptar (painel à direita acima do breakpoint; drawer abaixo).

### P3 (Nice to Have)

12. **[REQ-012]** O sistema DEVE lembrar o scroll/aba do painel.

## Edge Cases

- **Resize com drawer aberto** - ao cresizar para ≥900px, o mesmo bloco de info vira a coluna à direita (um único JSX, alternado por CSS).
- **localStorage indisponível** - default: desktop com painel aberto, mobile com drawer fechado; nunca quebra.
- **Sem peers / squad vazio** - as seções mostram o estado vazio atual.
- **Muitos peers** - o painel/drawer rola (`overflow-y: auto`).

## Architecture Decisions

1. **CSS Grid no `.wrap`** - mobile = 1 coluna (controles); ≥ 900px = `grid-template-columns: minmax(0,1fr) 340px` (controles | info). Alternativa descartada: flex com ordem — grid deixa as duas zonas explícitas.
2. **Um único bloco de info** - o painel à direita e o drawer são o MESMO JSX, alternado por CSS (media query): ≥900px vira coluna à direita; <900px vira drawer (`position: fixed` + `translateX`), controlado pelo estado `panelOpen`.
3. **`modo limpo` vira o toggle do painel** - estado persistido em localStorage (reusa a chave/ideia do `clean`). Desktop: recolhe a coluna; mobile: abre/fecha o drawer.
4. **Um breakpoint (900px)** separa "painel à direita" de "drawer".
5. **Uptime/sozinho discreto** - movido para uma linha pequena sob os botões; os rótulos redundantes saem. Só apresentação, zero mudança de API/dados.
6. **Sem libs** - drawer em CSS + backdrop; foco/Esc em JS leve (sem Radix/headless).

## Grilling Log

| # | Decision | Resolution | Rationale |
|---|----------|------------|-----------|
| 1 | Uptime/"tempo sozinho": remover ou mover? | Deixar junto aos botões, discreto | É dado útil; só o rótulo de estado é redundante |
| 2 | Info no mobile: drawer ou dialog? | Drawer (gaveta lateral) | Mais fluido, parece app |
| 3 | O que fazer com "modo limpo"? | Vira o toggle do painel (recolhe/drawer) | Reaproveita o conceito e a persistência |

## Constraints

- Só `web/src/app/page.tsx` + `web/src/app/globals.css`; sem mudar API/monitor/binário.
- Sem novas dependências.
- Manter a11y (foco, Esc, aria).
- pt-BR.

## Out of Scope

| Item | Reason |
|------|--------|
| Mudança em dados/contadores | É só layout |
| Novo tema claro/escuro | Fora do pedido |
| Refatorar lógica de Solo/Squad | Só apresentação |

## Test Strategy

- **Unit:** extrair um helper puro de persistência do estado do painel (como o `clean`) e testá-lo no vitest; o resto é visual.
- **Integration:** `tsc --noEmit` e `next build` limpos.
- **Visual/manual:** desktop (painel + recolher), tablet, mobile (drawer abre/fecha, Esc, foco visível).
- **A11y:** `role="dialog"` no drawer, `aria-expanded` no toggle, foco e Esc.

## Requirement Traceability

| ID | Description | Priority | Status |
|----|-------------|----------|--------|
| REQ-001 | Remover rótulos redundantes de estado | P1 | Pending |
| REQ-002 | Uptime/sozinho discreto junto aos botões | P1 | Pending |
| REQ-003 | Centro só com controles | P1 | Pending |
| REQ-004 | Info à direita no desktop/tablet | P1 | Pending |
| REQ-005 | Info em drawer no mobile | P1 | Pending |
| REQ-006 | "modo limpo" vira toggle do painel | P1 | Pending |
| REQ-007 | Persistir estado do painel | P1 | Pending |
| REQ-008 | Borda/cores indicam estado | P1 | Pending |
| REQ-009 | Cabeçalho + "ao vivo" permanecem | P1 | Pending |
| REQ-010 | Drawer: slide, Esc, foco | P2 | Pending |
| REQ-011 | Faixa de tablet adapta | P2 | Pending |
| REQ-012 | Lembrar scroll/aba | P3 | Pending |
