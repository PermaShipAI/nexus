# Nexus Command: User Guide & Onboarding

Welcome to the Nexus Command AI agents system. This guide explains how to install the bot, link it to your organization, and begin collaborating with your team of AI specialists.

---

## 1. Installation & Activation

### Step 1: Install the Bot
1.  Navigate to the PermaShip Dashboard.
2.  Go to **Settings > Integrations**.
3.  Click **"Add to Discord"** or **"Add to Slack"**.
4.  Follow the platform prompts to authorize the bot in your workspace.

### Step 2: Generate an Activation Token
1.  In the PermaShip Dashboard, navigate to **Settings > API Keys**.
2.  Click **"Generate Agent Activation Token"**.
3.  Copy the short-lived token provided.

### Step 3: Activate in Chat
1.  Go to the channel in Discord or Slack that you want to use as your **Internal Control Channel** (this is where sensitive proposals and admin commands will live).
2.  Type the following command:
    ```text
    !activate <your-token>
    ```
3.  **Success:** The bot will confirm that your workspace is now linked to your PermaShip Organization. This channel is now your primary control center.

---

## 2. Managing Your Agents

Once activated, you can configure how the agents behave within your workspace.

### Public Channels
By default, agents only listen to the Internal Control Channel. To have them monitor other channels (e.g., `#dev`, `#sre-alerts`, `#product-feedback`):
*   **Register a channel:** In the control channel, type `!public #channel-name`.
*   **Unregister a channel:** Type `!public off #channel-name`.

### Operating Modes
Manage the system's "brains" using these commands:
*   `!modes`: View current status of all settings and registered channels.
*   `!autonomous on/off`: 
    *   **Off (Default):** Agents propose tickets ➔ Nexus reviews ➔ Human approves ➔ Ticket created.
    *   **On:** Agents propose tickets ➔ Nexus reviews ➔ Ticket created automatically.
*   `!nexus-reports on/off`: Toggle whether the CTO agent (Nexus) posts a summary of its periodic background reviews to the channel.

---

## 3. Interacting with the Team

### Conversational Inquiries
You can ask the team questions directly. The **Router** will automatically identify which specialist is best suited to answer:
*   *"@PermaShip Agents, why is the build failing in the staging environment?"* (SRE/Release Engineering will respond)
*   *"What is our current data retention policy for user logs?"* (CISO will respond)

### Strategy Sessions
For complex goals that require multiple perspectives, ask for a plan:
*   *"@PermaShip Agents, give me a strategy for migrating our database to a new region."*
*   **Result:** The Strategy Coordinator will pull in 2-4 relevant agents (e.g., SRE, FinOps, CISO) to build a multi-step execution plan synthesized by Nexus.

### Immediate Idle Trigger
If the channel has been quiet and you want an agent to scan for work immediately:
*   `!trigger`: Triggers a random eligible agent to look for the next highest priority task.
*   `!trigger <agent-id>`: Triggers a specific agent (e.g., `!trigger ciso`).

---

## 4. The Proposal Lifecycle

The core value of the Nexus Command agents system is identifying and proposing work.

1.  **Discovery**: Agents scan your code and conversations (silently) to find bugs, technical debt, or feature opportunities.
2.  **Silent Proposal**: When an agent finds something, they submit a proposal to **Nexus** (the AI CTO). You will *not* see this yet.
3.  **Nexus Review**: Nexus evaluates the proposal against the organization's standards and existing ticket history.
4.  **Promotion**: If Nexus approves, the proposal is posted to your **Internal Control Channel** as a "Nexus-Reviewed Proposal."
5.  **Human Approval**:
    *   In the control channel, you will see a message with "Approve" and "Reject" buttons.
    *   Clicking **Approve** immediately creates a **Ticket Suggestion** in PermaShip and accepts it, turning it into a real implementation ticket.

---

## 5. Agent Personas
*   **agentops**: Internal system health and agent performance.
*   **ciso**: Security, authentication, and data isolation.
*   **finops**: Billing, Stripe integration, and cost optimization.
*   **product-manager**: Feature design and logic refinement.
*   **qa-manager**: Testing standards and regression prevention.
*   **release-engineering**: CI/CD pipelines and deployment workflows.
*   **sre**: Reliability, performance, and infrastructure.
*   **ux-designer**: UI/UX standards and accessibility.
*   **voc**: User feedback patterns and support issues.
*   **nexus**: The team lead and proposal gatekeeper.
