export function buildIntentPrompt(content: string, agentList: string[]): string {
  return `You are an intent classification system for a multi-agent routing pipeline.

Classify the following user message into exactly one of these 10 intents:

1. InvestigateBug - The user wants to investigate, debug, or report a bug or error in the system.
2. ProposeTask - The user wants to propose, create, or assign a new task or work item.
3. QueryKnowledge - The user wants to query or retrieve information from the knowledge base.
4. SystemStatus - The user wants to know the current status of a system, service, or component.
5. RequestReview - The user wants to request a review (code review, document review, etc.).
6. StrategySession - The user wants to discuss strategy, planning, or high-level direction.
7. GeneralInquiry - The user has a general question or request that doesn't fit other categories.
8. AdministrativeAction — The user wants to configure, enable, disable, or change a system setting or agent behavior.
9. DestructiveAction — The user wants to permanently delete, remove, or irreversibly modify data or configuration.
10. StrictConsultation — The user explicitly requests a read-only advisory response, stating the agent must NOT create tickets, propose tasks, approve/reject proposals, or take any mutative action.

Available agents: ${agentList.join(', ')}

User message:
<user_input>
${content}
</user_input>


Analyze the message and return a structured classification with:
- intent: one of the 10 intents listed above
- confidenceScore: a number between 0 and 1 indicating your confidence
- targetAgent: the most appropriate agent from the available agents list
- extractedEntities: key entities extracted from the message (as an object)
- reasoning: brief explanation of your classification
- needsCodeAccess: whether the task requires access to code repositories
- isStrategySession: whether this is a strategy or planning discussion
- requiresConfirmation: true if the action mutates critical system state or is irreversible, false otherwise.

For AdministrativeAction, always populate extractedEntities with settingKey (the configuration key) and settingValue (the desired new value) if discernible.

Confidence-scoring rule: when classifying a message as AdministrativeAction, the confidenceScore MUST fall below 0.6 if neither settingKey nor settingValue can be extracted from the utterance. A vague reference to "settings" or "configuration" without specifying which setting or what value to apply is insufficient to route with high confidence and must be reflected by a sub-0.6 score.

Examples:

Input: "enable autonomous mode"
{"intent":"AdministrativeAction","confidenceScore":0.97,"targetAgent":"nexus","extractedEntities":{"settingKey":"autonomousMode","settingValue":"enabled"},"reasoning":"User wants to enable a system setting.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "switch to debug logging"
{"intent":"AdministrativeAction","confidenceScore":0.95,"targetAgent":"nexus","extractedEntities":{"settingKey":"logLevel","settingValue":"debug"},"reasoning":"User wants to change a logging configuration setting.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "turn off safety checks"
{"intent":"AdministrativeAction","confidenceScore":0.96,"targetAgent":"nexus","extractedEntities":{"settingKey":"safetyChecks","settingValue":"disabled"},"reasoning":"User wants to disable a safety configuration.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "disable rate limiting"
{"intent":"AdministrativeAction","confidenceScore":0.92,"targetAgent":"nexus","extractedEntities":{"settingKey":"rateLimiting","settingValue":"disabled"},"reasoning":"User wants to disable rate limiting, a security-sensitive configuration that could expose the system to abuse.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "update memory retention to 7 days"
{"intent":"AdministrativeAction","confidenceScore":0.88,"targetAgent":"nexus","extractedEntities":{"settingKey":"memoryRetentionDays","settingValue":"7"},"reasoning":"User wants to update a data retention configuration with a specific numeric value.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "enable the experimental routing feature flag"
{"intent":"AdministrativeAction","confidenceScore":0.94,"targetAgent":"agentops","extractedEntities":{"settingKey":"experimentalRouting","settingValue":"enabled"},"reasoning":"User wants to enable an experimental feature flag for the routing system.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "reset agent config to defaults"
{"intent":"AdministrativeAction","confidenceScore":0.91,"targetAgent":"nexus","extractedEntities":{"settingKey":"agentConfig","settingValue":"default"},"reasoning":"User wants to reset agent configuration to factory defaults, a reversible but impactful change.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "change some system settings"
{"intent":"AdministrativeAction","confidenceScore":0.45,"targetAgent":"nexus","extractedEntities":{},"reasoning":"The message references system settings but does not specify which setting or the desired value, making it impossible to extract settingKey or settingValue and reducing confidence below the routing threshold.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "activate the new recommendation engine"
{"intent":"AdministrativeAction","confidenceScore":0.93,"targetAgent":"agentops","extractedEntities":{"settingKey":"recommendationEngine","settingValue":"active"},"reasoning":"User wants to activate a named system component using the activate verb, clearly indicating an administrative toggle.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "toggle dark mode on"
{"intent":"AdministrativeAction","confidenceScore":0.96,"targetAgent":"nexus","extractedEntities":{"settingKey":"darkMode","settingValue":"on"},"reasoning":"The toggle phrasing with an explicit on/off target value unambiguously describes a UI setting change.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "set the request timeout to 30 seconds"
{"intent":"AdministrativeAction","confidenceScore":0.95,"targetAgent":"nexus","extractedEntities":{"settingKey":"requestTimeoutSeconds","settingValue":"30"},"reasoning":"User provides a specific numeric parameter for a named configuration value, making both settingKey and settingValue fully extractable.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "hit the kill switch on the ingestion pipeline"
{"intent":"AdministrativeAction","confidenceScore":0.94,"targetAgent":"sre","extractedEntities":{"settingKey":"ingestionPipeline","settingValue":"disabled"},"reasoning":"The kill-switch idiom is an unambiguous instruction to disable a named subsystem, understood as an administrative shutdown action.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "reduce agent verbosity to minimal"
{"intent":"AdministrativeAction","confidenceScore":0.91,"targetAgent":"nexus","extractedEntities":{"settingKey":"agentVerbosity","settingValue":"minimal"},"reasoning":"User requests a change to an agent verbosity setting with a clearly specified target level.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "put the system in maintenance mode"
{"intent":"AdministrativeAction","confidenceScore":0.97,"targetAgent":"sre","extractedEntities":{"settingKey":"maintenanceMode","settingValue":"enabled"},"reasoning":"Maintenance mode is a well-known operational state; the request unambiguously targets a system-wide configuration change.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "can you do something about the config"
{"intent":"AdministrativeAction","confidenceScore":0.35,"targetAgent":"nexus","extractedEntities":{},"reasoning":"The utterance vaguely references config without specifying a settingKey or settingValue; confidence must fall below 0.6 per the scoring rule for unextractable administrative parameters.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "turn that thing on"
{"intent":"AdministrativeAction","confidenceScore":0.32,"targetAgent":"nexus","extractedEntities":{},"reasoning":"The request implies enabling something but provides no identifiable settingKey or settingValue; the referent 'that thing' is unresolvable without additional context, so confidence must fall below 0.6.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "delete ticket 123"
{"intent":"DestructiveAction","confidenceScore":0.98,"targetAgent":"nexus","extractedEntities":{"ticketId":"123"},"reasoning":"User wants to permanently delete a ticket.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":true}

Input: "what is the current log level?"
{"intent":"SystemStatus","confidenceScore":0.94,"targetAgent":"nexus","extractedEntities":{},"reasoning":"User is asking about the current state of a system configuration.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "just tell me your analysis, do NOT create any tickets or proposals"
{"intent":"StrictConsultation","confidenceScore":0.97,"targetAgent":"nexus","extractedEntities":{},"reasoning":"User explicitly instructs the agent to provide analysis only and not to create tickets or proposals — a read-only advisory request.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "give me your opinion on this approach but please don't take any actions or file any tickets"
{"intent":"StrictConsultation","confidenceScore":0.95,"targetAgent":"nexus","extractedEntities":{},"reasoning":"User asks for an opinion with an explicit prohibition on mutative actions such as filing tickets.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

Input: "I only want advice here — do not approve anything, reject anything, or create any proposals"
{"intent":"StrictConsultation","confidenceScore":0.96,"targetAgent":"nexus","extractedEntities":{},"reasoning":"User explicitly forbids approval, rejection, and proposal creation, requesting purely advisory output.","needsCodeAccess":false,"isStrategySession":false,"requiresConfirmation":false}

User message:
"""
${content}
"""

Return ONLY valid JSON. Do not include markdown fences or any other text.`;
}

export function LEGACY_ROUTING_PROMPT(
  content: string,
  agentList: string[],
  context: string,
): string {
  return `You are a routing assistant for a multi-agent pipeline.

Context:
${context}

Available agents: ${agentList.join(', ')}

User message:
<user_input>
${content}
</user_input>

Based on the message, determine which agent should handle this request and provide a brief explanation.
Return a plain text response with the agent name and reasoning.`;
}
