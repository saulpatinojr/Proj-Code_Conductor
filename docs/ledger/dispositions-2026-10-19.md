# Dispositions for corpus skills not in any Agent Pack (2026-10-19)

Ledger: ledger-2026-10-19.json (kept by the owner, not in this repository: 2 MB). Mark each group `package` (generate a pack in Agent Packs) or `exclude` (vendor-provided, installed by its own distribution, not migrated). Edit the `Disposition:` lines; nothing else is needed.

Recorded 2026-10-21: the owner chose the `Disposition:` lines below. Update the same day: the owner decided **not to package any group**, so every group is `exclude`. The owner reports that copies of the skills they care about already exist in APM and on GitHub. A name search of `Proj-Agent_Packs` on 2026-10-21 found no skill, agent or prompt with the 11 own-skill names below, so those copies are somewhere other than that repository. The only edit to the original file is that the account identifier folder inside the synced skill paths is replaced with `<id>`.

Result for issue #13: nothing is left to package and no pack needs generating.

## Review notes (2026-10-21)

1. **Several "own" skills were in Claude's trash folder when the ledger was taken** (their paths contain `.trash`): `azure-architect`, `azure-diagram-architect`, `aws-architect`, `aws-diagram-architect`, `cbts-onx-deck`, `adr-authoring`, `agentic-workflow-engineer`, `allocation-policy-architect`, `backend-engineer`, `budget-anomaly-operator` and `cloud-billing-analyst`. **Owner decision: they are not needed here**, because copies exist in APM and on GitHub; no backup was taken from the trash. Resolved.
2. **No pack is to be generated for them.** Generating a pack would have used the owner's subscription, and none is needed.
3. **`managing-python-dependencies` and `notebook-guidance` look vendor-published.** They sit in `user/copilot/skills` next to the Google data skills (`bigquery-sql`, `data-autocleaning`, `ml-best-practices` and others), so `exclude` applies to them too. Resolved.
4. **The "Anthropic built-in skills" group contains non-Anthropic items.** `customize`, `deploy`, `prepare`, `preset` and `scaffold` are sub-skills of the Azure skills `microsoft-foundry` and `azure-app-onboard`. `find-skills` and `skill-repair` are vendor tools. `exclude` still fits all of them.
5. **Keep `hcw-stack` and `cbts-onx-deck` out of the public Agent Packs repository** unless the owner has read them for private details.

## Google Cloud (GKE, BigQuery, Dataflow, Gemini, Google Ads, Analytics, Workspace, Firebase, Cloud SQL, AlloyDB, Bigtable, gcloud) (100)

Disposition: exclude

- agent-platform-alert-configuration  (user/agents/skills/agent-platform-alert-configuration/SKILL.md)
- agent-platform-deploy  (user/agents/skills/agent-platform-deploy/SKILL.md)
- agent-platform-endpoint-management  (user/agents/skills/agent-platform-endpoint-management/SKILL.md)
- agent-platform-eval-flywheel  (user/agents/skills/agent-platform-eval-flywheel/SKILL.md)
- agent-platform-inference  (user/agents/skills/agent-platform-inference/SKILL.md)
- agent-platform-migrate-from-ai-studio  (user/agents/skills/agent-platform-migrate-from-ai-studio/SKILL.md)
- agent-platform-model-registry  (user/agents/skills/agent-platform-model-registry/SKILL.md)
- agent-platform-prompt-management  (user/agents/skills/agent-platform-prompt-management/SKILL.md)
- agent-platform-rag-engine-management  (user/agents/skills/agent-platform-rag-engine-management/SKILL.md)
- agent-platform-skill-registry  (user/agents/skills/agent-platform-skill-registry/SKILL.md)
- agent-platform-tuning  (user/agents/skills/agent-platform-tuning/SKILL.md)
- agent-platform-tuning-management  (user/agents/skills/agent-platform-tuning-management/SKILL.md)
- alloydb-basics  (user/agents/skills/alloydb-basics/SKILL.md)
- bigquery-ai-ml  (user/agents/skills/bigquery-ai-ml/SKILL.md)
- bigquery-basics  (user/agents/skills/bigquery-basics/SKILL.md)
- bigquery-bigframes  (user/agents/skills/bigquery-bigframes/SKILL.md)
- bigquery-data-transfer-service  (user/copilot/skills/bigquery-data-transfer-service/SKILL.md)
- bigquery-sql  (user/copilot/skills/bigquery-sql/SKILL.md)
- bigtable-basics  (user/agents/skills/bigtable-basics/SKILL.md)
- building-data-apps  (user/copilot/skills/building-data-apps/SKILL.md)
- cloud-logging-query-generation  (user/agents/skills/cloud-logging-query-generation/SKILL.md)
- cloud-monitoring-metric-selection  (user/agents/skills/cloud-monitoring-metric-selection/SKILL.md)
- cloud-run-basics  (user/agents/skills/cloud-run-basics/SKILL.md)
- cloud-sql-basics  (user/agents/skills/cloud-sql-basics/SKILL.md)
- data-autocleaning  (user/copilot/skills/data-autocleaning/SKILL.md)
- data-manager-api-audience-ingestion  (user/agents/skills/data-manager-api-audience-ingestion/SKILL.md)
- data-manager-api-event-ingestion  (user/agents/skills/data-manager-api-event-ingestion/SKILL.md)
- data-manager-api-setup  (user/agents/skills/data-manager-api-setup/SKILL.md)
- dataform-bigquery  (user/copilot/skills/dataform-bigquery/SKILL.md)
- datalineage-bigquery-asset-impact-analysis  (user/agents/skills/datalineage-bigquery-asset-impact-analysis/SKILL.md)
- datalineage-summary  (user/agents/skills/datalineage-summary/SKILL.md)
- dbt-bigquery  (user/copilot/skills/dbt-bigquery/SKILL.md)
- detection-engineering-coverage-evaluation  (user/agents/skills/detection-engineering-coverage-evaluation/SKILL.md)
- discovering-gcp-data-assets  (user/copilot/skills/discovering-gcp-data-assets/SKILL.md)
- enforcing-resource-attribution  (user/copilot/skills/enforcing-resource-attribution/SKILL.md)
- firebase-basics  (user/agents/skills/firebase-basics/SKILL.md)
- gcloud  (user/agents/skills/gcloud/SKILL.md)
- gcp-data-pipelines  (user/copilot/skills/gcp-data-pipelines/SKILL.md)
- gcp-dataflow  (user/copilot/skills/gcp-dataflow/SKILL.md)
- gcp-pipeline-orchestration  (user/copilot/skills/gcp-pipeline-orchestration/SKILL.md)
- gcp-pipeline-resource-provisioning  (user/copilot/skills/gcp-pipeline-resource-provisioning/SKILL.md)
- gcp-spark  (user/copilot/skills/gcp-spark/SKILL.md)
- gcp-spark-troubleshooting  (user/copilot/skills/gcp-spark-troubleshooting/SKILL.md)
- gemini-agents-api  (user/agents/skills/gemini-agents-api/SKILL.md)
- gemini-api  (user/agents/skills/gemini-api/SKILL.md)
- gemini-interactions-api  (user/agents/skills/gemini-interactions-api/SKILL.md)
- gemini-live-api  (user/agents/skills/gemini-live-api/SKILL.md)
- gke-app-onboarding  (user/agents/skills/gke-app-onboarding/SKILL.md)
- gke-backup-dr  (user/agents/skills/gke-backup-dr/SKILL.md)
- gke-basics  (user/agents/skills/gke-basics/SKILL.md)
- gke-batch-hpc  (user/agents/skills/gke-batch-hpc/SKILL.md)
- gke-cluster-autoscaler  (user/agents/skills/gke-cluster-autoscaler/SKILL.md)
- gke-cluster-creation  (user/agents/skills/gke-cluster-creation/SKILL.md)
- gke-compute-classes  (user/agents/skills/gke-compute-classes/SKILL.md)
- gke-cost  (user/agents/skills/gke-cost/SKILL.md)
- gke-golden-path  (user/agents/skills/gke-golden-path/SKILL.md)
- gke-inference  (user/agents/skills/gke-inference/SKILL.md)
- gke-multitenancy  (user/agents/skills/gke-multitenancy/SKILL.md)
- gke-networking  (user/agents/skills/gke-networking/SKILL.md)
- gke-observability  (user/agents/skills/gke-observability/SKILL.md)
- gke-reliability  (user/agents/skills/gke-reliability/SKILL.md)
- gke-security  (user/agents/skills/gke-security/SKILL.md)
- gke-storage  (user/agents/skills/gke-storage/SKILL.md)
- gke-upgrades  (user/agents/skills/gke-upgrades/SKILL.md)
- gke-workload-scaling  (user/agents/skills/gke-workload-scaling/SKILL.md)
- google-ads-api-mcp-setup  (user/agents/skills/google-ads-api-mcp-setup/SKILL.md)
- google-ads-api-quickstart  (user/agents/skills/google-ads-api-quickstart/SKILL.md)
- google-agents-cli-onboarding  (user/agents/skills/google-agents-cli-onboarding/SKILL.md)
- google-analytics-admin-api-basics  (user/agents/skills/google-analytics-admin-api-basics/SKILL.md)
- google-analytics-data-api-basics  (user/agents/skills/google-analytics-data-api-basics/SKILL.md)
- google-cloud-auth-verification  (user/copilot/skills/google-cloud-auth-verification/SKILL.md)
- google-cloud-global-frontend-configuration  (user/agents/skills/google-cloud-global-frontend-configuration/SKILL.md)
- google-cloud-networking-observability  (user/agents/skills/google-cloud-networking-observability/SKILL.md)
- google-cloud-recipe-auth  (user/agents/skills/google-cloud-recipe-auth/SKILL.md)
- google-cloud-recipe-foundation-builder  (user/agents/skills/google-cloud-recipe-foundation-builder/SKILL.md)
- google-cloud-recipe-onboarding  (user/agents/skills/google-cloud-recipe-onboarding/SKILL.md)
- google-cloud-solution-agentic-ai-bidirectional-streaming  (user/agents/skills/google-cloud-solution-agentic-ai-bidirectional-streaming/SKILL.md)
- google-cloud-solution-agentic-ai-borderless-data-lakehouse  (user/agents/skills/google-cloud-solution-agentic-ai-borderless-data-lakehouse/SKILL.md)
- google-cloud-solution-agentic-ai-data-science-workflow  (user/agents/skills/google-cloud-solution-agentic-ai-data-science-workflow/SKILL.md)
- google-cloud-solution-agentic-analytics-spark-knowledge-catalog  (user/agents/skills/google-cloud-solution-agentic-analytics-spark-knowledge-catalog/SKILL.md)
- google-cloud-solution-architecture  (user/agents/skills/google-cloud-solution-architecture/SKILL.md)
- google-cloud-solution-build-deploy-agents  (user/agents/skills/google-cloud-solution-build-deploy-agents/SKILL.md)
- google-cloud-solution-n-tier-serverless-web-app  (user/agents/skills/google-cloud-solution-n-tier-serverless-web-app/SKILL.md)
- google-cloud-solution-rag-enterprise-search-gke-sqldb  (user/agents/skills/google-cloud-solution-rag-enterprise-search-gke-sqldb/SKILL.md)
- google-cloud-waf-cost-optimization  (user/agents/skills/google-cloud-waf-cost-optimization/SKILL.md)
- google-cloud-waf-operational-excellence  (user/agents/skills/google-cloud-waf-operational-excellence/SKILL.md)
- google-cloud-waf-performance-optimization  (user/agents/skills/google-cloud-waf-performance-optimization/SKILL.md)
- google-cloud-waf-reliability  (user/agents/skills/google-cloud-waf-reliability/SKILL.md)
- google-cloud-waf-security  (user/agents/skills/google-cloud-waf-security/SKILL.md)
- google-cloud-waf-sustainability  (user/agents/skills/google-cloud-waf-sustainability/SKILL.md)
- google-mobile-ads-android-migrate-to-next-gen  (user/agents/skills/google-mobile-ads-android-migrate-to-next-gen/SKILL.md)
- google-mobile-ads-banner  (user/agents/skills/google-mobile-ads-banner/SKILL.md)
- google-mobile-ads-get-started  (user/agents/skills/google-mobile-ads-get-started/SKILL.md)
- google-mobile-ads-interstitial  (user/agents/skills/google-mobile-ads-interstitial/SKILL.md)
- google-mobile-ads-rewarded  (user/agents/skills/google-mobile-ads-rewarded/SKILL.md)
- google-workspace  (user/claude/skills/synced/<id>/google-workspace/SKILL.md)
- ima-sdk-basics  (user/agents/skills/ima-sdk-basics/SKILL.md)
- ml-best-practices  (user/copilot/skills/ml-best-practices/SKILL.md)
- schema-mapping  (user/copilot/skills/schema-mapping/SKILL.md)
- workload-manager-basics  (user/agents/skills/workload-manager-basics/SKILL.md)

## Azure / Microsoft (36)

Disposition: exclude
Note: No carve-outs to package: the owner decided on 2026-10-21 not to package `azure-architect` or `azure-diagram-architect`. Keep `hcw-stack` and `cbts-onx-deck` out of the public Agent Packs repository.

- capacity  (user/agents/skills/microsoft-foundry/models/deploy-model/capacity/SKILL.md)
- deploy-model  (user/agents/skills/microsoft-foundry/models/deploy-model/SKILL.md)
- finetuning  (user/agents/skills/microsoft-foundry/finetuning/SKILL.md)
- airunway-aks-setup  (user/agents/skills/airunway-aks-setup/SKILL.md)
- appinsights-instrumentation  (user/agents/skills/appinsights-instrumentation/SKILL.md)
- azure-ai  (user/agents/skills/azure-ai/SKILL.md)
- azure-aigateway  (user/agents/skills/azure-aigateway/SKILL.md)
- azure-app-onboard  (user/agents/skills/azure-app-onboard/SKILL.md)
- azure-app-onboard-prereq  (user/agents/skills/azure-app-onboard-prereq/SKILL.md)
- azure-architect  (user/claude/skills/.trash/1790396856953-51328-tmcIzt/azure-architect/SKILL.md)
- azure-cloud-migrate  (user/agents/skills/azure-cloud-migrate/SKILL.md)
- azure-compliance  (user/agents/skills/azure-compliance/SKILL.md)
- azure-compute  (user/agents/skills/azure-compute/SKILL.md)
- azure-cost  (user/agents/skills/azure-cost/SKILL.md)
- azure-deploy  (user/agents/skills/azure-deploy/SKILL.md)
- azure-diagnostics  (user/agents/skills/azure-diagnostics/SKILL.md)
- azure-diagram-architect  (user/claude/skills/.trash/1790396857042-51328-0XdU4r/azure-diagram-architect/SKILL.md)
- azure-enterprise-infra-planner  (user/agents/skills/azure-enterprise-infra-planner/SKILL.md)
- azure-kubernetes  (user/agents/skills/azure-kubernetes/SKILL.md)
- azure-kubernetes-automatic-readiness  (user/agents/skills/azure-kubernetes/azure-kubernetes-automatic-readiness/SKILL.md)
- azure-kusto  (user/agents/skills/azure-kusto/SKILL.md)
- azure-messaging  (user/agents/skills/azure-messaging/SKILL.md)
- azure-prepare  (user/agents/skills/azure-prepare/SKILL.md)
- azure-quotas  (user/agents/skills/azure-quotas/SKILL.md)
- azure-reliability  (user/agents/skills/azure-reliability/SKILL.md)
- azure-resource-lookup  (user/agents/skills/azure-resource-lookup/SKILL.md)
- azure-resource-visualizer  (user/agents/skills/azure-resource-visualizer/SKILL.md)
- azure-storage  (user/agents/skills/azure-storage/SKILL.md)
- azure-upgrade  (user/agents/skills/azure-upgrade/SKILL.md)
- azure-validate  (user/agents/skills/azure-validate/SKILL.md)
- cbts-onx-deck  (user/claude/skills/.trash/1791184165029-42988-Y6jf9F/cbts-onx-deck/SKILL.md)
- entra-agent-id  (user/agents/skills/entra-agent-id/SKILL.md)
- entra-app-registration  (user/agents/skills/entra-app-registration/SKILL.md)
- hcw-stack  (user/agents/skills/hcw-stack/SKILL.md)
- microsoft-foundry  (user/agents/skills/microsoft-foundry/SKILL.md)
- python-appservice-deploy  (user/agents/skills/python-appservice-deploy/SKILL.md)

## AWS (8)

Disposition: exclude
Note: No carve-outs to package: the owner decided on 2026-10-21 not to package `aws-architect` or `aws-diagram-architect`.

- aws-agentic-ai  (user/agents/skills/aws-agentic-ai/SKILL.md)
- aws-architect  (user/claude/skills/.trash/1790396857023-51328-mBhFeG/aws-architect/SKILL.md)
- aws-cdk-development  (user/agents/skills/aws-cdk-development/SKILL.md)
- aws-cost-operations  (user/agents/skills/aws-cost-operations/SKILL.md)
- aws-diagram-architect  (user/claude/skills/.trash/1790396857044-51328-F6Rsi4/aws-diagram-architect/SKILL.md)
- aws-mcp-setup  (user/agents/skills/aws-mcp-setup/SKILL.md)
- aws-serverless-eda  (user/agents/skills/aws-serverless-eda/SKILL.md)
- aws-sst-development  (user/agents/skills/aws-sst-development/SKILL.md)

## Anthropic built-in skills (Claude.ai / Claude Code) (20)

Disposition: exclude

- built-in-browser  (user/claude/skills/.trash/1790396857281-51328-mcuACI/built-in-browser/SKILL.md)
- canvas-design  (user/claude/skills/synced/<id>/canvas-design/SKILL.md)
- chrome-browser  (user/claude/skills/.trash/1790396857210-51328-cB6UnK/chrome-browser/SKILL.md)
- computer-use  (user/claude/skills/.trash/1790396857104-51328-XZeJIs/computer-use/SKILL.md)
- customize  (user/agents/skills/microsoft-foundry/models/deploy-model/customize/SKILL.md)
- deep-research  (user/claude/skills/.trash/1790396857267-51328-qH1Gtg/deep-research/SKILL.md)
- deploy  (user/agents/skills/azure-app-onboard/deploy/SKILL.md)
- docs  (user/claude/skills/.trash/1790396856794-51328-VcfwYI/docs/SKILL.md)
- docx  (user/claude/skills/.trash/1790350208793-58988-AOixyO/docx/SKILL.md)
- find-skills  (user/agents/skills/find-skills/SKILL.md)
- import-memory  (user/claude/skills/.trash/1790396857262-51328-hInyon/import-memory/SKILL.md)
- morning  (user/claude/skills/.trash/1790396857411-51328-45A0fA/morning/SKILL.md)
- pdf  (user/claude/skills/synced/<id>/pdf/SKILL.md)
- pptx  (user/claude/skills/.trash/1790350208757-58988-SjUpdr/pptx/SKILL.md)
- prepare  (user/agents/skills/azure-app-onboard/prepare/SKILL.md)
- preset  (user/agents/skills/microsoft-foundry/models/deploy-model/preset/SKILL.md)
- scaffold  (user/agents/skills/azure-app-onboard/scaffold/SKILL.md)
- skill-creator  (user/claude/skills/.trash/1790396857400-51328-gLMJvF/skill-creator/SKILL.md)
- skill-repair  (user/copilot/skills/skill-repair/SKILL.md)
- xlsx  (user/claude/skills/.trash/1790350208770-58988-Xj3lEN/xlsx/SKILL.md)

## Claude Code plugins (Plaud, Notion) (11)

Disposition: exclude

- notion-knowledge-capture  (user/claude/skills/.trash/1790396857134-51328-8GxP99/notion-knowledge-capture/SKILL.md)
- notion-meeting-intelligence  (user/claude/skills/.trash/1790396857049-51328-cKo95R/notion-meeting-intelligence/SKILL.md)
- notion-research-documentation  (user/claude/skills/.trash/1790396857129-51328-vkeCEA/notion-research-documentation/SKILL.md)
- notion-spec-to-implementation  (user/claude/skills/.trash/1790396857008-51328-uo0qg3/notion-spec-to-implementation/SKILL.md)
- plaud-browse  (user/claude/skills/plaud-browse/SKILL.md)
- plaud-digest  (user/claude/skills/plaud-digest/SKILL.md)
- plaud-export  (user/claude/skills/plaud-export/SKILL.md)
- plaud-find  (user/claude/skills/plaud-find/SKILL.md)
- plaud-followup  (user/claude/skills/plaud-followup/SKILL.md)
- plaud-read  (user/claude/skills/plaud-read/SKILL.md)
- plaud-shared  (user/claude/skills/plaud-shared/SKILL.md)

## Code Workflow (lives in Proj-Code_Workflow) (6)

Disposition: exclude

- agent-registry-and-capability-discovery  (user/claude/skills/agent-registry-and-capability-discovery/SKILL.md)
- agentic-workflow-dispatch  (user/claude/skills/agentic-workflow-dispatch/SKILL.md)
- claude-hooks-and-guardrails  (user/claude/skills/claude-hooks-and-guardrails/SKILL.md)
- claude-subagent-delegation  (user/claude/skills/claude-subagent-delegation/SKILL.md)
- handoff-contract-and-state  (user/claude/skills/handoff-contract-and-state/SKILL.md)
- workflow-evidence-and-recovery  (user/claude/skills/workflow-evidence-and-recovery/SKILL.md)

## Agent-pack prompts kept as skills (candidates for Agent Packs) (8)

Disposition: exclude
Note: Changed from `package` on 2026-10-21 by the owner: these skills are not needed here because copies exist in APM and on GitHub. `managing-python-dependencies` and `notebook-guidance` look vendor-published (see review note 3).

- adr-authoring  (user/claude/skills/.trash/1790396857033-51328-noVPXS/adr-authoring/SKILL.md)
- agentic-workflow-engineer  (user/claude/skills/.trash/1790396856987-51328-bbUxzm/agentic-workflow-engineer/SKILL.md)
- allocation-policy-architect  (user/claude/skills/.trash/1790396856994-51328-xzpgA7/allocation-policy-architect/SKILL.md)
- backend-engineer  (user/claude/skills/.trash/1790396857061-51328-mFisIc/backend-engineer/SKILL.md)
- budget-anomaly-operator  (user/claude/skills/.trash/1790396857111-51328-uqu9wZ/budget-anomaly-operator/SKILL.md)
- cloud-billing-analyst  (user/claude/skills/.trash/1790396857293-51328-NcBtEC/cloud-billing-analyst/SKILL.md)
- managing-python-dependencies  (user/copilot/skills/managing-python-dependencies/SKILL.md)
- notebook-guidance  (user/copilot/skills/notebook-guidance/SKILL.md)

## Unclassified (1): likely an Azure or Google data-protection skill; check its SKILL.md

Disposition: exclude

- accidental-data-loss-prevention  (user/copilot/skills/accidental-data-loss-prevention/SKILL.md)
