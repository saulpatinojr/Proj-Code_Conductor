# Marketplace publishing: the owner's setup, step by step

Implements the owner side of #14 (D-067). After these steps, the Release workflow's
**Publish to the Marketplace** job publishes every `vMAJOR.MINOR.PATCH` release after you
approve it in GitHub. Nothing here stores a long-lived secret: the job signs in to
Microsoft Entra ID with a short-lived token from GitHub (workload identity federation),
which is what Microsoft recommends now that Azure DevOps retires global personal access
tokens on 2026-12-01
([Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)).

Do the steps in this order. Each one says where you do it, what you copy, and how you
check it. Values that are fixed for this repository are given exactly.

## Fixed values for this repository

| Value | Exact text | Where it comes from |
|---|---|---|
| Repository | `saulpatinojr/Proj-Code_Conductor` | |
| Repository owner ID | `34853639` | GitHub user ID of `saulpatinojr` |
| Repository ID | `1365370915` | GitHub repository ID |
| Environment name | `marketplace` | `.github/workflows/release.yml`, `publish` job |
| OIDC issuer | `https://token.actions.githubusercontent.com` | [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) |
| OIDC subject | `repo:saulpatinojr@34853639/Proj-Code_Conductor@1365370915:environment:marketplace` | immutable format, see step 4 |
| OIDC audience | `api://AzureADTokenExchange` | default of [`azure/login`](https://github.com/Azure/login) |
| Extension name | `code-conductor-vscode` | `apps/vscode/package.json` |

The subject uses GitHub's **immutable** format, with the owner and repository IDs, because
this repository was created on 2026-09-11 and renamed on 2026-09-18 (ADR 0010); GitHub
moved repositories created or renamed after 2026-07-15 to that format
([Immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)).
The older `repo:saulpatinojr/Proj-Code_Conductor:environment:marketplace` will **not**
match. If you want to see the claim GitHub actually sends before trusting it, run
[`github/actions-oidc-debugger`](https://github.com/github/actions-oidc-debugger) once
in a throwaway workflow.

## Prerequisites

- You are signed in to `gh` as the repository owner (`gh auth status`), with Windows
  PowerShell 5.1 or PowerShell 7 for the owner scripts
  ([`scripts/owner/README.md`](../scripts/owner/README.md)).
- A Microsoft account (personal or work) for the Marketplace publisher.
- A Microsoft Entra tenant you can register applications in. An Azure account gives you
  one (the "default directory"); no Azure subscription is needed. To create one:
  [Create a new tenant](https://learn.microsoft.com/entra/fundamentals/create-new-tenant).
- Azure CLI for the one-time lookup in step 5:
  [Install the Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).
- The `main` and all-tags rulesets from [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md)
  (`scripts/owner/Set-RepositoryGovernance.ps1`, #3). D-067's guarantee that only
  reviewed commits are released rests on them.

## Step 1: create the publisher

Where: [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage).
Reference: [Create a publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher).

1. Sign in with the Microsoft account that will **own** the publisher. Prefer an account
   in the Entra tenant you will use in step 3, so the identity you add in step 5 is in the
   same directory as the owner.
2. Select **Create publisher**.
3. **ID**: lowercase letters, digits and hyphens only, starting with a letter or digit
   (the packaging script enforces `^[A-Za-z0-9][A-Za-z0-9-]*$`). It cannot be changed
   later and appears in every extension URL (`<ID>.code-conductor-vscode`).
4. **Name**: the display name shown in the Marketplace. Check it is not already taken.
5. Select **Create**. Write the ID down; the next steps call it `<publisher-id>`.

## Step 2: set the publisher variable and protect the environment

Where: a PowerShell prompt in a clone of this repository.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\owner\Set-MarketplaceEnvironment.ps1 -Publisher <publisher-id> -WhatIf
.\scripts\owner\Set-MarketplaceEnvironment.ps1 -Publisher <publisher-id>
```

The script sets the `VSCE_PUBLISHER` repository variable, creates the `marketplace`
environment with you as its **required reviewer**, and allows only `v*` tags to deploy to
it. It stores no credential.

Check in the browser: **Settings → Environments → marketplace** shows *Required
reviewers: you* and *Deployment branches and tags: Selected, Tag `v*`*
([Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
And:

```powershell
gh variable list --repo saulpatinojr/Proj-Code_Conductor
```

shows `VSCE_PUBLISHER` with your publisher ID.

## Step 3: register the application in Microsoft Entra ID

Where: [Microsoft Entra admin center](https://entra.microsoft.com) → **Entra ID** →
**App registrations** → **New registration**.
Reference: [Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app).

1. **Name**: `code-conductor-marketplace-publisher` (any name; it shows in sign-in logs).
2. **Supported account types**: *Accounts in this organizational directory only*.
3. Leave **Redirect URI** empty. Select **Register**.
4. On the app's **Overview** page copy:
   - **Application (client) ID** → this is `AZURE_CLIENT_ID`;
   - **Directory (tenant) ID** → this is `AZURE_TENANT_ID`;
   - **Object ID** → used only if you add the federated credential with the CLI.

Registering in the portal also creates the app's service principal (its **Enterprise
application**) in your tenant. If you registered with `az ad app create` instead, run
`az ad sp create --id <client-id>` once.

## Step 4: add the federated credential for the `marketplace` environment

Where: the app registration → **Certificates & secrets** → **Federated credentials** →
**Add credential**.
Reference: [Configure an app to trust an external identity provider](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust?pivots=identity-wif-apps-methods-azp#github-actions).

Use the **Other issuer** scenario, not *GitHub Actions deploying Azure resources*: that
scenario fills in the older subject format, which this repository no longer sends.

| Field | Value |
|---|---|
| Federated credential scenario | **Other issuer** |
| Issuer | `https://token.actions.githubusercontent.com` |
| Type | Explicit subject identifier |
| Subject identifier | `repo:saulpatinojr@34853639/Proj-Code_Conductor@1365370915:environment:marketplace` |
| Name | `github-marketplace-environment` (cannot be changed later) |
| Audience | `api://AzureADTokenExchange` |

Select **Add**. The same credential from the CLI:

```sh
cat > credential.json <<'EOF'
{
  "name": "github-marketplace-environment",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:saulpatinojr@34853639/Proj-Code_Conductor@1365370915:environment:marketplace",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "Code Conductor Release workflow, marketplace environment"
}
EOF
az ad app federated-credential create --id <object-id> --parameters credential.json
```

The subject must match the token's `sub` claim exactly, including the environment name's
case (`marketplace`).

## Step 5: make the application a member of the publisher

The Marketplace adds members by their Marketplace **user ID**, and a service principal
gets one the first time it signs in to Azure DevOps services. So you sign in as the
application once, read its ID, then add that ID to the publisher.
Reference: [Publish with a Microsoft Entra token](https://learn.microsoft.com/azure/devops/extend/publish/command-line?view=azure-devops#publish-with-a-microsoft-entra-token)
and [Add additional users to manage your publisher account](https://learn.microsoft.com/visualstudio/extensibility/walkthrough-publishing-a-visual-studio-extension?view=visualstudio#add-additional-users-to-manage-your-publisher-account).

1. **Temporary client secret, for this lookup only.** In the app registration:
   **Certificates & secrets → Client secrets → New client secret**, description
   `one-time marketplace id lookup`, the shortest expiry offered. Copy the **Value** now;
   it is shown once.
2. **Sign in as the application and read its Marketplace ID:**

   ```sh
   az login --service-principal --username <client-id> --password <secret-value> --tenant <tenant-id> --allow-no-subscriptions
   # 499b84ac-1321-427f-aa17-267ca6975798 is the Azure DevOps resource ID
   az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
   az logout
   ```

   Copy the `id` field of the JSON (a GUID).
3. **Delete the client secret** in **Certificates & secrets → Client secrets**. From here
   on the application has no secret at all; it signs in only through the federated
   credential from step 4.
4. **Add the member.** In [publisher management](https://marketplace.visualstudio.com/manage)
   select your publisher → **Members** → **Add** → paste the GUID from step 5.2 as the
   user ID → **Role: Contributor** (publish and manage extensions, no publisher
   settings) → **Add**.

   If the portal answers `TF14045: The identity could not be found`, you pasted a name or
   e-mail instead of the ID, or the publisher's owner account is not in the same Entra
   tenant as the application. In the second case, sign in to publisher management with an
   account from that tenant, add it to the publisher as **Owner**, then add the member
   again while signed in as that account.

## Step 6: store the two IDs as environment secrets

Where: a terminal signed in to `gh`.
Reference: [`gh secret set`](https://cli.github.com/manual/gh_secret_set).

```sh
gh secret set AZURE_CLIENT_ID --env marketplace --repo saulpatinojr/Proj-Code_Conductor
gh secret set AZURE_TENANT_ID --env marketplace --repo saulpatinojr/Proj-Code_Conductor
```

Each command prompts for the value; paste the client ID and the tenant ID from step 3.
They go in the **environment**, not the repository, so only a job that passed the
environment's required-reviewer rule can read them. Check:

```sh
gh secret list --env marketplace --repo saulpatinojr/Proj-Code_Conductor
```

## Step 7: turn the Publish job on

Do this last. While the variable is absent the job is skipped, and a skipped job never
creates the environment, so nothing can publish through an environment that has no
reviewer yet.
Reference: [`gh variable set`](https://cli.github.com/manual/gh_variable_set).

```sh
gh variable set MARKETPLACE_PUBLISH --body true --repo saulpatinojr/Proj-Code_Conductor
gh variable list --repo saulpatinojr/Proj-Code_Conductor
```

## Step 8: the first release

1. Cut the release as [`RELEASE.md`](RELEASE.md#cutting-a-release) describes: version
   bump and changelog in a pull request, merge, tag `vX.Y.Z` on `main`, push the tag.
2. In **Actions → Release**, the jobs run in order: *Release candidate*, *Attest build
   provenance*, *Draft GitHub release*, then **Publish to the Marketplace** stops with
   *Waiting for review*.
3. Review the draft release first ([`RELEASE.md`](RELEASE.md#cutting-a-release), step 4):
   checksums, attestation, a clean-machine install of the `.vsix`.
4. Approve the deployment: open the waiting run → **Review deployments** → tick
   `marketplace` → **Approve and deploy**. The job verifies the candidate again, signs in
   with the federated credential and runs `vsce publish --azure-credential --packagePath`
   with the repository's locked `@vscode/vsce`.
5. Confirm at `https://marketplace.visualstudio.com/items?itemName=<publisher-id>.code-conductor-vscode`,
   then publish the GitHub draft release.

Declining the deployment publishes nothing and leaves the draft and attestation in place.

## If something fails

| Symptom | Cause | Fix |
|---|---|---|
| Publish job shows *skipped* | `MARKETPLACE_PUBLISH` is not exactly `true` | step 7 |
| Publish job never asks for approval and runs at once | the environment has no required reviewer | step 2; check **Settings → Environments** |
| `azure/login`: `AADSTS70021: No matching federated identity record found` | the subject or audience does not match | step 4: immutable subject, exact environment name, audience `api://AzureADTokenExchange` |
| `azure/login`: `AADSTS700016` / application not found | wrong `AZURE_CLIENT_ID` or `AZURE_TENANT_ID`, or the secret is in the repository instead of the environment | steps 3 and 6 |
| `vsce publish`: 401 or 403 | the application is not a **Contributor** of this publisher, or `VSCE_PUBLISHER` is not this publisher's ID | steps 5 and 2 |
| `vsce publish`: extension name already exists | another publisher owns `code-conductor-vscode` | choose a new extension `name` in `apps/vscode/package.json` in a reviewed pull request |
| Candidate job: `Tag … is not on main` | the tag was pushed from a branch | tag `refs/remotes/origin/main` as in [`RELEASE.md`](RELEASE.md#cutting-a-release) |

## References

- VS Code: [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), sections *Create a publisher* and *Secure automated publishing to Visual Studio Marketplace*; `vsce` 2.26.1 or newer is required for `--azure-credential` (this repository locks 4.0.0).
- Microsoft Learn: [Configure an app to trust an external identity provider](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust?pivots=identity-wif-apps-methods-azp#github-actions); [Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app); [Publish with a Microsoft Entra token](https://learn.microsoft.com/azure/devops/extend/publish/command-line?view=azure-devops#publish-with-a-microsoft-entra-token); [Add users to a publisher](https://learn.microsoft.com/visualstudio/extensibility/walkthrough-publishing-a-visual-studio-extension?view=visualstudio#add-additional-users-to-manage-your-publisher-account); [Retirement of global personal access tokens](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).
- GitHub: [Configuring OpenID Connect in Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure); [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc) (immutable subject claims); [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments); [`gh secret set`](https://cli.github.com/manual/gh_secret_set); [`gh variable set`](https://cli.github.com/manual/gh_variable_set).
- Action: [`azure/login`](https://github.com/Azure/login), pinned in `release.yml` to v2.3.1 (`7184910d9eb2b1c5e48f7073824a90609bb9b6d6`).
