---
feature: panel-layout
phase: implement
spec_path: docs/specs/panel-layout/SPEC.md
plan_path: docs/plans/2026-10-01-panel-layout.md
started_at: "2026-10-01"
updated_at: "2026-10-01"
language: pt-BR
decisions:
  - "Remove redundant state labels (SOLO ATIVO/INATIVO, jogando normalmente) — state is shown by border + button color/text"
  - "Only the control buttons centered; general info (squad, metrics, peers, health) relocated to a right column (desktop/tablet) and a drawer/dialog (mobile)"
  - "Responsive two-zone layout"
blockers: []
transitions:
  - "2026-10-01: research started (UI redesign of web/src/app/page.tsx + globals.css)"
---
