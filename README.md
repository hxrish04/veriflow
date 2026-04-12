# VeriFlow

VeriFlow is a QA automation copilot that turns Azure DevOps requirements into Playwright test coverage, executes the generated spec, and presents the results in a reviewable UI.

It is built as a lightweight internal-tool style MVP focused on a practical workflow:

1. Import a work item from Azure DevOps or enter a requirement manually
2. Generate a test plan, test cases, and a runnable Playwright spec
3. Execute the generated suite against a target URL
4. Review the result summary, per-test outcomes, and saved run history

## Why this project exists

Product and QA teams often describe behavior in user stories and acceptance criteria, while automation lives separately in test code. VeriFlow closes that gap by converting requirement text into executable browser tests and making the output easy to review.

## Core features

- Azure DevOps work-item import
- Story-to-test generation from requirements and acceptance criteria
- Playwright spec generation using ES module syntax
- In-app execution results with totals, durations, and per-test outcomes
- Plain-English run summaries for quick review
- Saved run history with filtering
- Scheduled reruns while the server is active

## Tech stack

- Node.js
- Express
- Playwright
- Vanilla HTML/CSS/JavaScript frontend
- Anthropic API for test generation and summary generation

## Local setup

### 1. Install dependencies

```bash
npm install
npx playwright install
```

### 2. Create `.env`

Copy `.env.example` to `.env` and set:

```bash
ANTHROPIC_API_KEY=your_key_here
AZURE_DEVOPS_ORG=your_org
AZURE_DEVOPS_PROJECT=your_project
AZURE_DEVOPS_PAT=your_pat
PORT=3001
```

### 3. Start the app

```bash
npm start
```

Then open:

```text
http://localhost:3001
```

## Demo flow

For a quick demo:

1. Import an Azure DevOps work item or enter a requirement manually
2. Use `https://wikipedia.org` as the target URL
3. Generate tests from the requirement
4. Run the generated Playwright suite
5. Review `Execution Results` and `Run History`

### Known demo scenario

This is a stable example flow used during development:

- Target URL: `https://wikipedia.org`
- Requirement: `As a user, I want to search the site so that I can find information quickly`
- Acceptance criteria:
  - A search input field is visible on the homepage
  - A user can type a query into the search input
  - A user can submit the search using Enter or the search action
  - Relevant search results are displayed after submission

## Project structure

```text
veriflow/
  client/
    assets/
    index.html
  server/
    data/
    index.js
  generated/
    generated.spec.js
  playwright.config.js
  package.json
```

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/azure-stories` | Fetch recent Azure DevOps user stories and issues |
| POST | `/generate-tests` | Generate a test plan, test cases, and Playwright code |
| POST | `/run-tests` | Execute the generated spec and return a structured report |
| GET | `/generated-code` | Return the saved generated Playwright spec |
| GET | `/run-history` | Return persisted execution history |
| GET | `/schedule` | Return current scheduled execution state |
| POST | `/schedule` | Turn scheduled execution off or set `5m`, `30m`, or `1h` |

## Notes

- Generated specs are written to `generated/generated.spec.js`
- Run history is persisted by the server for refresh-safe viewing
- Scheduled execution is designed for demo/prototype use while the local server is running

## GitHub checklist

For a clean GitHub upload:

1. Keep the repository private
2. Do not upload `.env`
3. Install dependencies locally before running the app
4. Use `.env.example` as the setup template for anyone who needs to run the project

Suggested repository name:

- `veriflow`
- `veriflow-qa-copilot`

Suggested short description:

- `QA automation copilot that turns Azure DevOps requirements into Playwright tests, executes them, and summarizes the results in a reviewable UI.`
