# Prompt maestro para inicializar `surtec-control-plane`

Este documento contiene un prompt listo para usar con **Codex en VS Code** o **Codex CLI** dentro de un repositorio vacío llamado `surtec-control-plane`.

La intención es que Codex cree la estructura base del **Surtec Control Plane**: una capa propia de orquestación, agentes, skills, automatizaciones, adaptadores y monitoreo de upstreams, sin depender directamente de Paperclip ni de ningún otro repositorio externo.

---

## Cómo usar este prompt

### Opción A — Codex en VS Code

1. Abrí VS Code en la carpeta vacía:

```bash
cd ~/dev/surtec-control-plane
code .
```

2. Abrí Codex en VS Code.
3. Pegá el prompt de la sección **Prompt para Codex**.
4. Pedile que ejecute la creación de archivos.
5. Revisá el diff antes de aceptar cambios.

### Opción B — Codex CLI interactivo

```bash
cd ~/dev/surtec-control-plane
codex
```

Luego pegá el prompt de la sección **Prompt para Codex**.

### Opción C — Codex CLI no interactivo

Guardá este archivo como, por ejemplo:

```bash
~/dev/surtec-control-plane/bootstrap-surtec-control-plane-prompt.md
```

Luego ejecutá:

```bash
cd ~/dev/surtec-control-plane

codex exec \
  --sandbox workspace-write \
  "$(cat bootstrap-surtec-control-plane-prompt.md)"
```

---

# Prompt para Codex

```text
Actuá como arquitecto principal de Surtec y como bootstrap engineer.

Estoy dentro de un repositorio vacío llamado `surtec-control-plane`.

Quiero que inicialices el repositorio completo para crear el control plane de Surtec.

## Objetivo general

Crear una estructura base para:

- Orquestar proyectos de software actuales y futuros.
- Usar Paperclip como orquestador inicial, pero sin depender rígidamente de Paperclip.
- Permitir reemplazar Paperclip en el futuro por otro dashboard/orquestador.
- Usar Codex CLI como ejecutor automatizable de tareas.
- Tener un catálogo propio de agentes de Surtec.
- Tener skills propios de Surtec: software, QA, producto, seguridad y legal argentino.
- Tener automatizaciones con scripts, GitHub Actions, cron y CI.
- Tener registry de compañías, proyectos, agentes, rutinas y permisos.
- Tener upstream monitor para vigilar cambios en repos externos:
  - paperclipai/paperclip
  - obra/superpowers
  - msitarzewski/agency-agents
  - cristianaboitiz-eng/claude-for-legal-argentina
- Mantener los proyectos reales como repos separados fuera de este control plane.

## Contexto conceptual

El sistema debe pensarse así:

Surtec Control Plane
  ├─ Orquestador: Paperclip, o reemplazo futuro
  ├─ Ejecutor: Codex CLI
  ├─ Catálogo de agentes: Surtec Agent Lab
  ├─ Skills: legales, técnicos, QA, producto, seguridad
  ├─ Automatizaciones: scripts, GitHub Actions, cron, CI
  ├─ Proyectos: legal-ai-workbench, stock-control, appointment-manager...
  └─ Upstream Monitor: vigila cambios en repos externos

Los proyectos reales deben vivir como repos separados, por ejemplo:

surtec/
  legal-ai-workbench/
  stock-control/
  appointment-manager/
  automation-lab/
  portfolio-site/
  personal-saas/

Este repositorio `surtec-control-plane` no debe mezclar el código fuente de esos productos. Debe administrar, orquestar, documentar, ejecutar y monitorear.

## Regla arquitectónica central

No hardcodear dependencia directa a Paperclip.

Paperclip debe tratarse como un orquestador externo inicial. La integración debe pasar por una capa adaptadora.

La arquitectura deseada es:

Paperclip / otro orquestador
  ↓
Surtec Adapter Layer
  ↓
Codex CLI
  ↓
Repos de proyectos Surtec

Crear un contrato genérico de tarea llamado `TaskEnvelope` para que Paperclip, GitHub Issues, Linear, Jira, una CLI propia o un dashboard futuro puedan generar tareas con la misma forma.

## Reglas de ejecución

- Primero inspeccioná el repo actual.
- Si está vacío, creá toda la estructura.
- Si algún archivo ya existe, no lo pises sin explicar.
- No ejecutes `codex exec` desde adentro del bootstrap.
- No clones repos externos todavía.
- No instales dependencias todavía.
- No pongas secrets reales.
- No uses credenciales reales.
- No hagas deploy.
- No hagas commits.
- Creá archivos iniciales útiles, no solo carpetas vacías.
- Agregá `.gitkeep` donde haga falta conservar carpetas vacías.
- Hacé scripts shell con `set -euo pipefail`.
- Marcá scripts ejecutables con `chmod +x`.
- Usá nombres claros y convenciones simples.
- Al final, mostrame un resumen y el árbol creado.

## Estructura mínima requerida

Crear esta estructura base:

surtec-control-plane/
  README.md
  AGENTS.md
  .gitignore
  package.json

  .github/
    workflows/
      upstream-watcher.yml

  docker/
    paperclip/
      docker-compose.yml
      .env.example
      README.md

  registry/
    companies.yml
    projects.yml
    agents.yml
    routines.yml
    permissions.yml
    upstreams.yml

  schemas/
    task-envelope.schema.json
    agent-result.schema.json

  adapters/
    codex-runner/
      README.md
      run-task.sh
      run-task.ts
    paperclip-codex-adapter/
      README.md
      src/
        index.ts
        mapper.ts
        types.ts

  agents/
    codex/
      product-manager.toml
      tech-lead.toml
      backend-engineer.toml
      frontend-engineer.toml
      qa-reviewer.toml
      security-reviewer.toml
      devops-engineer.toml
      reality-checker.toml
      documentation-writer.toml
      legal-reviewer-ar.toml

  skills/
    legal-argentina/
      contract-review/
        SKILL.md
        references/
          .gitkeep
      diagnostico-juridico/
        SKILL.md
        references/
          .gitkeep
      privacy-data-ar/
        SKILL.md
        references/
          .gitkeep
    software/
      code-review/
        SKILL.md
      test-plan/
        SKILL.md
      architecture-review/
        SKILL.md
      deployment-review/
        SKILL.md
      systematic-debugging/
        SKILL.md
    product/
      mvp-scope/
        SKILL.md
      feature-prioritization/
        SKILL.md
      user-story-writing/
        SKILL.md
    security/
      threat-model/
        SKILL.md
      secrets-review/
        SKILL.md

  upstreams/
    paperclip/
      README.md
      .gitkeep
    superpowers/
      README.md
      .gitkeep
    agency-agents/
      README.md
      .gitkeep
    claude-for-legal-argentina/
      README.md
      .gitkeep

  transforms/
    agency-agents-to-codex/
      README.md
      preview.sh
      build.sh
    legal-ar-to-codex-skills/
      README.md
      preview.sh
      build.sh

  evals/
    agents/
      README.md
      .gitkeep
    legal/
      README.md
      .gitkeep
    paperclip-adapter/
      README.md
      .gitkeep
    projects/
      README.md
      .gitkeep

  scripts/
    upstream/
      check-updates.sh
      generate-diff-report.sh
      update-paperclip-preview.sh
      update-superpowers-preview.sh
      update-legal-ar.sh
      update-agency-agents.sh
    projects/
      bootstrap-project.sh
      create-agent-branch.sh
      run-codex-task.sh
      create-worktree.sh
    validation/
      validate-registry.sh
      validate-schemas.sh

  docs/
    operating-model.md
    agent-governance.md
    update-policy.md
    security-policy.md
    paperclip-integration.md
    codex-cli-usage.md
    superpowers-usage.md
    project-lifecycle.md
    upstream-monitor.md
    task-envelope-contract.md

  reports/
    .gitkeep

  tmp/
    .gitkeep

## Contenido esperado de los archivos principales

### README.md

Crear un README claro con:

- Qué es Surtec Control Plane.
- Qué NO es.
- Arquitectura general.
- Relación con Paperclip.
- Relación con Codex CLI.
- Relación con Codex en VS Code.
- Relación con Superpowers.
- Relación con agency-agents.
- Relación con claude-for-legal-argentina.
- Cómo se organizan los proyectos Surtec.
- Cómo ejecutar una tarea con Codex CLI.
- Cómo agregar un nuevo proyecto.
- Cómo agregar un nuevo agente.
- Cómo vigilar upstreams.
- Estado inicial: scaffold / no producción.

### AGENTS.md

Crear reglas globales para agentes que trabajen en este repo:

- Trabajar en español salvo indicación contraria.
- No modificar proyectos externos desde este repo salvo que el usuario lo indique.
- No hacer deploy.
- No tocar secrets.
- No usar `danger-full-access`.
- Usar `read-only` para análisis.
- Usar `workspace-write` para generación/edición controlada.
- No hacer merge a main.
- No actualizar upstreams automáticamente sin PR/revisión.
- Paperclip es opcional y reemplazable.
- Codex CLI es el ejecutor principal.
- Superpowers debe usarse como metodología para tareas de desarrollo cuando esté instalado.
- Toda entrega debe incluir resumen, archivos modificados, comandos ejecutados, riesgos y próximos pasos.

### package.json

Crear un package.json mínimo para scripts internos:

- `validate`
- `validate:registry`
- `validate:schemas`
- `upstream:check`
- `project:bootstrap`
- `task:run`

No instalar dependencias. Usar scripts shell.

### .gitignore

Incluir:

- node_modules
- dist
- build
- .env
- .env.*
- !.env.example
- reports/*.jsonl
- reports/*.log
- tmp/*
- !tmp/.gitkeep
- .DS_Store
- coverage

### registry/companies.yml

Crear ejemplo:

company:
  id: surtec
  name: Surtec
  description: Software studio personal/equipo inicial para proyectos propios y futuros productos.
  default_orchestrator: paperclip
  default_executor: codex-cli
  status: bootstrap

### registry/projects.yml

Crear ejemplos:

projects:
  legal-ai-workbench:
    repo: git@github.com:surtec/legal-ai-workbench.git
    local_path: ~/dev/surtec/legal-ai-workbench
    default_branch: main
    status: planned
    allowed_agents:
      - product-manager
      - tech-lead
      - backend-engineer
      - frontend-engineer
      - qa-reviewer
      - security-reviewer
      - legal-reviewer-ar
      - reality-checker
    sandbox:
      default: workspace-write
      legal_review: read-only
    commands:
      install: pnpm install
      test: pnpm test
      build: pnpm build
      lint: pnpm lint
    approval:
      before_merge: true
      before_deploy: true

  stock-control:
    repo: git@github.com:surtec/stock-control.git
    local_path: ~/dev/surtec/stock-control
    default_branch: main
    status: active
    allowed_agents:
      - product-manager
      - tech-lead
      - backend-engineer
      - frontend-engineer
      - qa-reviewer
      - security-reviewer
      - devops-engineer
      - reality-checker
      - documentation-writer
    sandbox:
      default: workspace-write
    commands:
      install: pnpm install
      test: pnpm test
      build: pnpm build
      lint: pnpm lint
    approval:
      before_merge: true
      before_deploy: true

  appointment-manager:
    repo: git@github.com:surtec/appointment-manager.git
    local_path: ~/dev/surtec/appointment-manager
    default_branch: main
    status: planned
    allowed_agents:
      - product-manager
      - tech-lead
      - backend-engineer
      - frontend-engineer
      - qa-reviewer
      - security-reviewer
      - reality-checker
    sandbox:
      default: workspace-write
    commands:
      install: pnpm install
      test: pnpm test
      build: pnpm build
      lint: pnpm lint
    approval:
      before_merge: true
      before_deploy: true

Agregar también automation-lab, portfolio-site y personal-saas como planned.

### registry/agents.yml

Definir agentes con:

- id
- name
- type
- description
- codex_agent_file
- default_sandbox
- allowed_task_types
- requires_human_approval_for

Incluir:

- product-manager
- tech-lead
- backend-engineer
- frontend-engineer
- qa-reviewer
- security-reviewer
- devops-engineer
- reality-checker
- documentation-writer
- legal-reviewer-ar

### registry/routines.yml

Crear rutinas:

- daily-surtec-standup
- weekly-engineering-review
- weekly-upstream-watch
- monthly-strategy-review
- legal-skills-review

Cada rutina debe tener:

- id
- schedule
- description
- agents
- outputs
- requires_human_review

### registry/permissions.yml

Definir permisos:

- sandbox modes permitidos
- agentes que pueden editar
- agentes que solo pueden leer
- prohibición de tocar secrets
- prohibición de deploy sin aprobación
- prohibición de merge automático
- política de branches/worktrees

### registry/upstreams.yml

Definir upstreams:

upstreams:
  paperclip:
    repo: https://github.com/paperclipai/paperclip.git
    strategy: release
    pinned: null
    criticality: high
    update_policy: manual-review
    notes: Paperclip es orquestador inicial, no dependencia rígida.

  superpowers:
    repo: https://github.com/obra/superpowers.git
    strategy: release-or-commit
    pinned: null
    criticality: high
    update_policy: manual-review
    notes: Metodología de trabajo para agentes de coding.

  agency-agents:
    repo: https://github.com/msitarzewski/agency-agents.git
    strategy: commit
    pinned: null
    criticality: medium
    update_policy: selective-import
    notes: Catálogo de inspiración para agentes, no importar completo.

  claude-for-legal-argentina:
    repo: https://github.com/cristianaboitiz-eng/claude-for-legal-argentina.git
    strategy: commit
    pinned: null
    criticality: high
    update_policy: legal-review-required
    notes: Fuente de referencia para skills legales argentinos adaptados a Codex.

### schemas/task-envelope.schema.json

Crear JSON Schema para una tarea genérica:

Campos mínimos:

- id
- source
- project
- task_type
- agent
- title
- instructions
- repo_path
- branch
- sandbox
- expected_outputs
- requires_human_approval
- metadata

El objetivo es que Paperclip u otro orquestador puedan emitir la misma forma de tarea.

### schemas/agent-result.schema.json

Crear JSON Schema para el resultado de un agente:

Campos mínimos:

- task_id
- agent
- status
- summary
- files_changed
- commands_run
- tests_run
- risks
- blockers
- next_steps
- artifacts
- logs_path

### adapters/codex-runner/run-task.sh

Crear script ejecutable que acepte:

```bash
./adapters/codex-runner/run-task.sh <task-json-file>
```

Debe:

- validar que existe el archivo JSON
- extraer campos básicos con Node o Python
- resolver repo_path
- entrar al repo
- mostrar comando `codex exec` que se ejecutaría
- opcionalmente ejecutar si `SURTEC_EXECUTE=1`
- usar `--sandbox` según la tarea
- usar `--json`
- guardar salida en `reports/`
- no hacer merge
- no hacer deploy

Si no hay Node/Python disponible, debe fallar de forma clara.

### adapters/codex-runner/run-task.ts

Crear versión TypeScript inicial del runner:

- leer TaskEnvelope desde archivo
- validar campos básicos sin dependencia externa
- construir comando Codex CLI
- ejecutar con child_process si `SURTEC_EXECUTE=1`
- si no, imprimir dry-run
- escribir logs en reports

No instalar dependencias.

### adapters/paperclip-codex-adapter

Crear un adapter conceptual inicial.

Debe incluir:

- README explicando que Paperclip es opcional/reemplazable
- src/types.ts con tipos PaperclipTask, TaskEnvelope, AgentResult
- src/mapper.ts para convertir una tarea Paperclip-like a TaskEnvelope
- src/index.ts como placeholder de entrada

No debe depender de una API real de Paperclip todavía. Debe ser una capa preparada para adaptar.

### agents/codex/*.toml

Crear agentes Codex iniciales.

Cada agente debe tener:

- name
- description
- sandbox_mode
- developer_instructions

Reglas comunes:

- respetar AGENTS.md del repo
- no hacer merge
- no hacer deploy
- no tocar secrets
- devolver resumen, archivos modificados, comandos, riesgos y próximos pasos
- usar Superpowers si está instalado y corresponde

Agentes:

1. product-manager
2. tech-lead
3. backend-engineer
4. frontend-engineer
5. qa-reviewer
6. security-reviewer
7. devops-engineer
8. reality-checker
9. documentation-writer
10. legal-reviewer-ar

Para `legal-reviewer-ar`, usar `read-only` por defecto y aclarar:

- asistente jurídico argentino
- no reemplaza revisión profesional
- no inventar normativa
- marcar puntos que requieran verificación actualizada
- usar skills legal-argentina cuando correspondan

### skills

Crear SKILL.md útiles, no vacíos.

Formato:

```md
---
name: nombre-del-skill
description: descripción clara de cuándo debe activarse
---

# Skill: ...

## Objetivo

## Cuándo usarlo

## Procedimiento

## Formato de salida

## Límites
```

Skills mínimos:

#### legal-argentina/contract-review

- revisión de contratos bajo derecho argentino
- red flags
- cláusulas ausentes
- jurisdicción
- datos personales
- consumidor
- laboral si corresponde
- salida como borrador para revisión humana

#### legal-argentina/diagnostico-juridico

- clasificación inicial de caso
- rama del derecho
- hechos relevantes
- documentación faltante
- riesgos
- preguntas al abogado/persona responsable

#### legal-argentina/privacy-data-ar

- datos personales Argentina
- Ley 25.326 como referencia general
- no inventar normativa
- marcar verificación actualizada

#### software/code-review

- correctitud
- seguridad
- tests
- mantenibilidad
- diffs
- riesgos

#### software/test-plan

- estrategia de pruebas
- unitarias
- integración
- e2e
- casos borde
- regresión

#### software/architecture-review

- arquitectura
- límites
- dependencias
- escalabilidad
- mantenibilidad

#### software/deployment-review

- CI/CD
- variables de entorno
- migraciones
- rollback
- logs
- observabilidad

#### software/systematic-debugging

- reproducir
- aislar
- hipótesis
- causa raíz
- fix mínimo
- verificación

#### product/mvp-scope

- alcance de MVP
- fuera de scope
- riesgos de sobreconstrucción
- criterios de éxito

#### product/feature-prioritization

- impacto
- esfuerzo
- riesgo
- dependencia
- secuencia

#### product/user-story-writing

- historias de usuario
- acceptance criteria
- casos borde

#### security/threat-model

- activos
- actores
- amenazas
- mitigaciones
- riesgos residuales

#### security/secrets-review

- detectar exposición de secrets
- .env
- logs
- tokens
- keys
- permisos

### upstreams

Crear README por upstream explicando:

- qué repo externo representa
- cómo se actualiza
- si se usa como fork, submodule o snapshot
- política de actualización
- riesgos

No clonar nada todavía.

### transforms

Crear scripts `preview.sh` y `build.sh` para:

#### agency-agents-to-codex

- preview: listar candidatos de agentes a importar si existe upstream
- build: generar/actualizar agentes Codex seleccionados
- por ahora puede ser placeholder robusto con mensajes claros

#### legal-ar-to-codex-skills

- preview: detectar archivos legales fuente si existe upstream
- build: generar/actualizar skills legales
- por ahora puede ser placeholder robusto con mensajes claros
- debe requerir revisión humana

Todos los scripts deben ser ejecutables.

### evals

Crear README en cada carpeta explicando qué se evaluará:

- agents
- legal
- paperclip-adapter
- projects

Incluir criterios de evaluación:

- respeta formato
- no inventa
- no toca secrets
- no hace merge
- corre tests cuando corresponde
- marca riesgos
- pide revisión humana si corresponde

### scripts/upstream

Crear scripts:

#### check-updates.sh

- revisar si existen carpetas upstream
- si son repos git, hacer fetch
- generar reporte simple en reports/
- no actualizar automáticamente

#### generate-diff-report.sh

- generar diff/status de upstreams
- guardar en reports/

#### update-paperclip-preview.sh

- preparar preview de actualización de Paperclip
- no mergear
- no deployar

#### update-superpowers-preview.sh

- preparar preview de actualización de Superpowers
- no aplicar automáticamente

#### update-legal-ar.sh

- actualizar preview legal
- ejecutar transform preview/build si corresponde
- exigir revisión humana

#### update-agency-agents.sh

- actualizar preview de agency-agents
- no importar todo automáticamente

### scripts/projects

Crear scripts:

#### bootstrap-project.sh

Uso:

```bash
./scripts/projects/bootstrap-project.sh <project-name> <local-path>
```

Debe:

- crear AGENTS.md inicial en el proyecto si no existe
- crear carpetas docs/superpowers/specs y docs/superpowers/plans
- no pisar archivos existentes
- preparar integración con Surtec Control Plane

#### create-agent-branch.sh

Uso:

```bash
./scripts/projects/create-agent-branch.sh <repo-path> <task-id> <agent-id>
```

Debe:

- crear branch `agent/<task-id>-<agent-id>`
- no continuar si hay cambios sin commitear
- no hacer push por defecto

#### create-worktree.sh

Uso:

```bash
./scripts/projects/create-worktree.sh <repo-path> <task-id> <agent-id>
```

Debe:

- crear worktree en `../surtec-worktrees/<repo-name>-<task-id>-<agent-id>`
- crear branch asociada
- no continuar si falla

#### run-codex-task.sh

Uso:

```bash
./scripts/projects/run-codex-task.sh <project-id> <agent-id> <task-id> <task-text>
```

Debe:

- leer registry/projects.yml
- resolver local_path
- construir prompt para Codex CLI
- dry-run por defecto
- ejecutar solo si `SURTEC_EXECUTE=1`
- guardar logs en reports/

### scripts/validation

Crear scripts:

#### validate-registry.sh

- verificar que los archivos registry existan
- validar YAML de forma básica si Python con yaml está disponible
- si no, hacer validación de existencia mínima

#### validate-schemas.sh

- verificar que los schemas JSON sean parseables
- usar Python stdlib json

### .github/workflows/upstream-watcher.yml

Crear workflow semanal y manual:

- schedule semanal
- workflow_dispatch
- checkout
- ejecutar scripts/upstream/check-updates.sh
- subir reportes como artifact si existen

No debe hacer updates automáticos ni deploy.

### docker/paperclip

Crear:

#### docker-compose.yml

Debe ser placeholder útil para Paperclip, no necesariamente final.

- dejar comentarios
- usar variables desde `.env`
- no incluir secrets
- indicar que se debe adaptar cuando se configure Paperclip real

#### .env.example

Variables placeholder:

- PAPERCLIP_PORT
- PAPERCLIP_DATABASE_URL
- PAPERCLIP_SECRET
- SURTEC_CONTROL_PLANE_PATH

#### README.md

Explicar:

- Paperclip es orquestador inicial
- se recomienda usar fork propio
- no hacer deploy desde upstream main/master
- integrar vía adapter

### docs

Crear documentación inicial:

#### operating-model.md

Explicar modelo operativo:

- Surtec como software studio
- humanos deciden
- agentes proponen/implementan/revisan
- Paperclip coordina
- Codex ejecuta
- VS Code permite revisión visual

#### agent-governance.md

Reglas:

- agentes no hacen merge
- agentes no hacen deploy
- agentes no tocan secrets
- worktrees/branches por tarea
- revisión humana

#### update-policy.md

Política para:

- Paperclip
- Superpowers
- agency-agents
- claude-for-legal-argentina
- Codex CLI
- proyectos Surtec

#### security-policy.md

Reglas de seguridad:

- secrets
- sandbox
- permisos
- logs
- datos sensibles
- legal/privacy

#### paperclip-integration.md

Explicar adapter layer:

- Paperclip no es dependencia central
- TaskEnvelope
- adapter
- reemplazo futuro

#### codex-cli-usage.md

Incluir ejemplos:

- análisis read-only
- implementación workspace-write
- ejecución con task JSON
- logs JSONL
- uso manual en VS Code

#### superpowers-usage.md

Explicar cómo usar Superpowers como metodología:

- brainstorming
- writing plans
- worktrees
- TDD
- debugging
- review
- verification
- finishing branch

#### project-lifecycle.md

Explicar lifecycle:

- idea
- spec
- plan
- implementation
- review
- PR
- merge humano
- release

#### upstream-monitor.md

Explicar cómo se vigilan upstreams.

#### task-envelope-contract.md

Documentar el contrato TaskEnvelope.

## Requisitos de calidad

- No crear archivos vacíos salvo `.gitkeep`.
- Los README deben ser útiles.
- Los scripts deben tener mensajes claros.
- Los TOML deben ser válidos.
- Los JSON schemas deben ser parseables.
- Los YAML deben ser legibles.
- No usar dependencias externas innecesarias.
- No ejecutar instalaciones.
- No ejecutar clones.
- No llamar APIs externas.
- No requerir secretos.
- Todo debe quedar listo para revisión en VS Code.

## Resultado final esperado

Al final, devolvé:

1. Resumen de lo creado.
2. Árbol del repo.
3. Archivos principales modificados/creados.
4. Comandos que ejecutaste.
5. Riesgos o pendientes.
6. Próximos pasos recomendados.

No hagas commit.
No hagas push.
No instales dependencias.
No clones upstreams.
No ejecutes Paperclip.
```

---

# Prompt corto alternativo

Usá este si querés una versión más compacta para pegar rápido:

```text
Inicializá este repo vacío `surtec-control-plane` como el control plane de Surtec.

Objetivo: crear una capa propia para gestionar proyectos, agentes, skills, automatizaciones, upstreams y adaptadores, usando Paperclip como orquestador inicial pero sin depender rígidamente de él. Codex CLI será el ejecutor principal. Los proyectos reales vivirán en repos separados bajo `~/dev/surtec/`.

Creá estructura, archivos base, scripts, docs, registries YAML, schemas JSON, agentes Codex TOML, skills SKILL.md, adapter Paperclip→TaskEnvelope→Codex CLI, runner Codex, upstream watcher y GitHub Action semanal.

No clones repos externos, no instales dependencias, no hagas commits, no hagas deploy, no uses secrets, no ejecutes `codex exec` todavía.

Debe incluir como mínimo:

- README.md
- AGENTS.md
- .gitignore
- package.json
- .github/workflows/upstream-watcher.yml
- docker/paperclip/
- registry/{companies,projects,agents,routines,permissions,upstreams}.yml
- schemas/{task-envelope,agent-result}.schema.json
- adapters/codex-runner/
- adapters/paperclip-codex-adapter/
- agents/codex/*.toml
- skills/legal-argentina/
- skills/software/
- skills/product/
- skills/security/
- upstreams/{paperclip,superpowers,agency-agents,claude-for-legal-argentina}/
- transforms/
- evals/
- scripts/upstream/
- scripts/projects/
- scripts/validation/
- docs/

Reglas:
- Paperclip debe ser opcional/reemplazable.
- Crear contrato genérico TaskEnvelope.
- Scripts en bash con `set -euo pipefail`.
- Scripts ejecutables con chmod +x.
- No archivos vacíos salvo .gitkeep.
- Crear documentación útil.
- Usar dry-run por defecto.
- Toda ejecución real debe requerir `SURTEC_EXECUTE=1`.
- Al final mostrar resumen, árbol, comandos, riesgos y próximos pasos.
```

---

# Próximos pasos sugeridos después del bootstrap

Una vez que Codex cree la estructura:

```bash
cd ~/dev/surtec-control-plane

./scripts/validation/validate-schemas.sh
./scripts/validation/validate-registry.sh
./scripts/upstream/check-updates.sh
```

Luego probá con un proyecto real, por ejemplo:

```bash
./scripts/projects/bootstrap-project.sh stock-control ~/dev/surtec/stock-control
```

Y después una tarea dry-run:

```bash
./scripts/projects/run-codex-task.sh \
  stock-control \
  backend-engineer \
  STK-001 \
  "Analizar estructura del proyecto y proponer mejoras iniciales sin modificar archivos."
```

Para ejecución real:

```bash
SURTEC_EXECUTE=1 ./scripts/projects/run-codex-task.sh \
  stock-control \
  backend-engineer \
  STK-001 \
  "Analizar estructura del proyecto y proponer mejoras iniciales sin modificar archivos."
```

Mi recomendación: primero validá que el scaffold quede ordenado, después conectá un solo proyecto, después un solo agente, y recién después integrá Paperclip.
