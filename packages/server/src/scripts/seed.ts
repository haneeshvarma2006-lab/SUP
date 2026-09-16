/**
 * Creates a demo account and workspace so a fresh checkout has something to
 * open.
 *
 *   npm run seed
 *
 * Safe to re-run: if the demo account already exists it just reports the
 * credentials rather than failing or duplicating anything.
 */
import { createApp } from '../app.js';
import { errorMessage } from '../util/errors.js';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@sup.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';
const NAME = process.env.SEED_NAME ?? 'Demo Human';

async function main(): Promise<void> {
  const app = createApp();

  const existing = app.repos.users.byEmail(EMAIL);
  const user = existing ?? app.auth.register({
    email: EMAIL,
    password: PASSWORD,
    displayName: NAME,
  }).user;

  const workspaces = app.repos.workspaces.listForUser(user.id);

  if (workspaces.length === 0) {
    const created = app.workspaces.createWorkspace({
      name: 'Startup HQ',
      description: 'A shared room for the founding team and its agents.',
      owner: app.repos.users.byId(user.id)!,
    });

    // A couple of seeded constraints, so the first run demonstrates that memory
    // actually reaches the agents rather than starting empty.
    await app.memory.write({
      workspaceId: created.workspace.id,
      scope: 'project',
      kind: 'constraint',
      title: 'Never invent sources',
      content:
        'Every factual claim in a deliverable must trace to a retrieved source or be explicitly ' +
        'labelled as inference. A fabricated citation is worse than an admitted gap.',
      createdBy: { type: 'user', id: user.id, name: NAME },
      pinned: true,
      importance: 0.95,
      source: 'seed',
    });

    await app.memory.write({
      workspaceId: created.workspace.id,
      scope: 'project',
      kind: 'preference',
      title: 'Reports lead with the recommendation',
      content:
        'Put the recommendation and the "so what" in the first two paragraphs. Supporting detail ' +
        'goes below it, not before it.',
      createdBy: { type: 'user', id: user.id, name: NAME },
      importance: 0.75,
      source: 'seed',
    });

    process.stdout.write(
      `Created workspace "${created.workspace.name}" with ${created.agents.length} agents:\n` +
        created.agents.map((a) => `  ${a.avatarEmoji} ${a.name} — ${a.role}\n`).join(''),
    );
  } else {
    process.stdout.write(`Account already has ${workspaces.length} workspace(s).\n`);
  }

  const provider = app.providers.default();

  process.stdout.write(
    `\nSign in at http://localhost:${app.config.port}\n` +
      `  email:    ${EMAIL}\n` +
      `  password: ${PASSWORD}\n\n` +
      `AI provider: ${provider.displayName}\n` +
      (provider.isLanguageModel
        ? ''
        : '  No model credentials configured. Agents will run the deterministic offline\n' +
          '  policy, which exercises the whole platform but is not a language model.\n' +
          '  Set ANTHROPIC_API_KEY to run them on a real model.\n'),
  );

  await app.shutdown();
}

main().catch((err: unknown) => {
  process.stderr.write(`Seed failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
