import { describe, it, expect } from 'vitest';
import { analyzeFile, type Violation } from '../enforce-deferral.js';

/** Run the analyzer against an inline source string. */
function analyze(source: string): Violation[] {
  return analyzeFile('<test-input>', source);
}

describe('enforce-deferral: deferral compliance', () => {
  // ── Passing cases ──────────────────────────────────────────────────────────

  it('passes when deferReply() is the first await', () => {
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        await someSlowOperation();
        await interaction.editReply('done');
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('passes when deferUpdate() is the first await (button handler)', () => {
    const source = `
      async function handler(interaction: ButtonInteraction) {
        await interaction.deferUpdate();
        await doWork();
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('passes when deferReply({ ephemeral: true }) is the first await', () => {
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        await routeIntent(content, context);
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('passes when synchronous preflight runs before the first await', () => {
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        const user = getLinkedUser(interaction.user.id);  // sync — allowed
        if (!user) return;
        await interaction.deferReply();
        await routeIntent(content, context);
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('passes when the handler has no await expressions at all', () => {
    // A purely-synchronous handler does not need deferral.
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        interaction.reply('immediate response');
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('ignores non-async functions with Interaction parameter', () => {
    const source = `
      function helper(interaction: ButtonInteraction): string {
        return interaction.customId;
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('ignores functions whose parameter is not an Interaction type', () => {
    const source = `
      async function processMessage(message: Message) {
        await message.react('⏳');
        await doSlowWork();
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('ignores arrow function callbacks inside the handler (nested scope)', () => {
    // Awaits inside nested arrow functions must NOT affect the outer check.
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        const run = async () => {
          await doSlowWork();  // nested — does not count for outer check
        };
        await interaction.deferReply();
        await run();
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  it('passes for ModalSubmitInteraction handler with correct deferral', () => {
    const source = `
      async function handleModal(interaction: ModalSubmitInteraction) {
        await interaction.deferReply({ ephemeral: true });
        await saveFormData(interaction.fields);
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });

  // ── Failing cases ──────────────────────────────────────────────────────────

  it('fails when there is no deferral before a slow async call', () => {
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        await routeIntent(content, context);
        await interaction.editReply('done');
      }
    `;
    const violations = analyze(source);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('deferReply');
    expect(violations[0].message).toContain("'handler'");
  });

  it('fails when a slow operation precedes deferReply', () => {
    const source = `
      async function handler(interaction: ChatInputCommandInteraction) {
        await fetchUserData();
        await interaction.deferReply();
        await routeIntent(content, context);
      }
    `;
    const violations = analyze(source);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBeGreaterThan(0);
    expect(violations[0].column).toBeGreaterThan(0);
  });

  it('fails for ButtonInteraction handler missing deferUpdate', () => {
    const source = `
      async function onButton(interaction: ButtonInteraction) {
        await saveToDatabase(interaction.customId);
        await interaction.deferUpdate();
      }
    `;
    const violations = analyze(source);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("'onButton'");
  });

  it('fails and reports <anonymous> for arrow function handlers', () => {
    const source = `
      const handler = async (interaction: ChatInputCommandInteraction) => {
        await doWork();
        await interaction.deferReply();
      };
    `;
    const violations = analyze(source);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('<anonymous>');
  });

  it('reports exactly one violation per offending function', () => {
    const source = `
      async function badHandler(interaction: ChatInputCommandInteraction) {
        await doSlowThing();
        await interaction.deferReply();
      }
    `;
    expect(analyze(source)).toHaveLength(1);
  });

  it('reports multiple violations when multiple handlers are non-compliant', () => {
    const source = `
      async function handlerA(interaction: ChatInputCommandInteraction) {
        await slowCallA();
      }
      async function handlerB(interaction: ButtonInteraction) {
        await slowCallB();
      }
    `;
    expect(analyze(source)).toHaveLength(2);
  });

  it('does not flag a compliant handler when a sibling handler is also compliant', () => {
    const source = `
      async function handlerA(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        await slowCallA();
      }
      async function handlerB(interaction: ButtonInteraction) {
        await interaction.deferUpdate();
        await slowCallB();
      }
    `;
    expect(analyze(source)).toHaveLength(0);
  });
});
