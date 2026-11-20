# OpenCode ticket-to-PR pipeline - entry points for using this template.
# Run `make` (or `make help`) to see all targets.

TEMPLATE_DIR := $(abspath .opencode)
SCRIPTS      := $(abspath scripts)

# Overridable from the command line, e.g. `make init PROJECT=../my-repo`.
PROJECT ?=
TICKET  ?=
RC_FILE ?=
DRY_RUN ?=
FORCE   ?=
JIRA_REVIEW_STATUS ?= In Review

.DEFAULT_GOAL := help
.PHONY: help install uninstall doctor init vendor ticket test

help: ## Show this help
	@echo "OpenCode ticket-to-PR pipeline"
	@echo
	@echo "Usage: make <target> [VAR=value ...]"
	@echo
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-10s %s\n", $$1, $$2}'
	@echo
	@echo "Typical first run:"
	@echo "  make install && source ~/.bashrc"
	@echo "  make doctor"
	@echo "  make init PROJECT=~/projects/my-repo"
	@echo "  make ticket PROJECT=~/projects/my-repo TICKET=CHAT-42"

install: ## Make the template available in every project (adds OPENCODE_CONFIG_DIR to your shell rc; RC_FILE=... to override)
	@RC_FILE="$(RC_FILE)" "$(SCRIPTS)/shell-rc.sh" install "$(TEMPLATE_DIR)"

uninstall: ## Remove the OPENCODE_CONFIG_DIR block from your shell rc
	@RC_FILE="$(RC_FILE)" "$(SCRIPTS)/shell-rc.sh" uninstall

doctor: ## Check opencode, credentials and that the template loads
	@"$(SCRIPTS)/doctor.sh" "$(TEMPLATE_DIR)"

init: ## Add the Pipeline section (base branch, checks) to PROJECT's AGENTS.md (DRY_RUN=1 to preview)
	@test -n "$(PROJECT)" || { echo "Usage: make init PROJECT=<path-to-repo> [DRY_RUN=1] [JIRA_REVIEW_STATUS='In Review']"; exit 2; }
	@DRY_RUN="$(DRY_RUN)" JIRA_REVIEW_STATUS="$(JIRA_REVIEW_STATUS)" "$(SCRIPTS)/init-project.sh" "$(PROJECT)"

vendor: ## Copy the pipeline into PROJECT's own .opencode/ (no global setup needed; re-run to update; DRY_RUN=1, FORCE=1)
	@test -n "$(PROJECT)" || { echo "Usage: make vendor PROJECT=<path-to-repo> [DRY_RUN=1] [FORCE=1]"; exit 2; }
	@DRY_RUN="$(DRY_RUN)" FORCE="$(FORCE)" "$(SCRIPTS)/vendor.sh" "$(TEMPLATE_DIR)" "$(PROJECT)"
	@echo
	@DRY_RUN="$(DRY_RUN)" JIRA_REVIEW_STATUS="$(JIRA_REVIEW_STATUS)" "$(SCRIPTS)/init-project.sh" "$(PROJECT)"

ticket: ## Start the pipeline for TICKET in PROJECT (opens the OpenCode TUI)
	@test -n "$(PROJECT)" -a -n "$(TICKET)" || { echo "Usage: make ticket PROJECT=<path-to-repo> TICKET=<KEY-123>"; exit 2; }
	@echo "$(TICKET)" | grep -Eq '^[A-Z][A-Z0-9_]+-[0-9]+$$' || { echo "TICKET must look like CHAT-42, got '$(TICKET)'"; exit 2; }
	OPENCODE_CONFIG_DIR="$(TEMPLATE_DIR)" opencode "$(PROJECT)" --agent orchestrator --prompt "Run the pipeline for Jira ticket $(TICKET)."

test: ## Run the template's own unit tests
	node --test "tests/*.test.ts"
