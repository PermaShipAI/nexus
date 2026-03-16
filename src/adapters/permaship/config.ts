/**
 * PermaShip-specific configuration.
 * Reads directly from process.env — only used by PermaShip adapter code.
 */
export const permashipConfig = {
  get PERMASHIP_API_KEY() { return process.env.PERMASHIP_API_KEY ?? ''; },
  get PERMASHIP_API_URL() { return process.env.PERMASHIP_API_URL ?? ''; },
  get PERMASHIP_ORG_ID() { return process.env.PERMASHIP_ORG_ID ?? ''; },
  get PERMASHIP_PROJECT_ID() { return process.env.PERMASHIP_PROJECT_ID; },
  get PERMASHIP_INTERNAL_SECRET() { return process.env.PERMASHIP_INTERNAL_SECRET; },
  get COMMS_API_URL() { return process.env.COMMS_API_URL ?? 'https://comms.permaship.ai'; },
  get COMMS_SIGNING_SECRET() { return process.env.COMMS_SIGNING_SECRET ?? process.env.CONDUCTOR_BOT_SECRET ?? ''; },
  get COMMS_AGENT_API_KEY() { return process.env.COMMS_AGENT_API_KEY; },
  get GEMINI_API_KEY() { return process.env.GEMINI_API_KEY ?? ''; },
};
