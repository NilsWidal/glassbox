import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../../src/cli/index.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'sample-repo');

function io(cwd: string, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => '',
    env: { GLASSBOX_BACKEND: 'fake' },
    cwd,
    ...extra,
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glassbox-cal-cli-'));
  await cp(FIXTURE, root, { recursive: true });
  return root;
}

describe('cli: label, calibrate, bench', () => {
  it('ask, label, calibrate, then ask applies the fitted calibrator', async () => {
    const root = await repo();
    // Always 0.95 yes; labels say it is right only 6 times in 10.
    const cfg = { backendConfig: { fake: { rules: [() => 0.95] } } };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = io(root, cfg);
      expect(await main(['ask', `Does this query the db, try ${i}?`, '--path', 'src/db.ts', '--no-why', '--json'], t.io)).toBe(0);
      ids.push((JSON.parse(t.out()) as { id: string }).id);
    }
    for (const [i, id] of ids.entries()) {
      const t = io(root);
      expect(await main(['label', id.slice(0, 8), i < 6 ? 'yes' : 'no'], t.io)).toBe(0);
      expect(t.out()).toContain(`labeled ${id}`);
    }

    const c = io(root);
    expect(await main(['calibrate'], c.io)).toBe(0);
    expect(c.out()).toMatch(/q {2}fake \(fake-1\) {2}temperature T=/);
    expect(c.out()).toContain('ECE=');
    expect(c.out()).toContain('saved');
    const file = JSON.parse(await readFile(join(root, '.glassbox', 'calibration.json'), 'utf8')) as { entries: Array<{ calibrator: { T: number } }> };
    expect(file.entries[0]!.calibrator.T).toBeGreaterThan(1);

    const after = io(root, cfg);
    expect(await main(['ask', 'Does this query the db?', '--path', 'src/db.ts', '--no-why', '--json'], after.io)).toBe(0);
    const json = JSON.parse(after.out()) as { answer: { p: number } };
    expect(json.answer.p).toBeLessThan(0.9);
    expect(json.answer.p).toBeGreaterThan(0.5);
  });

  it('calibrate with no labels exits 1 with a hint', async () => {
    const t = io(await repo());
    expect(await main(['calibrate'], t.io)).toBe(1);
    expect(t.err()).toContain('glassbox label');
  });

  it('label rejects an answer that is not an option', async () => {
    const root = await repo();
    const a = io(root);
    await main(['ask', 'Does this query the db?', '--path', 'src/db.ts', '--no-why', '--json'], a.io);
    const id = (JSON.parse(a.out()) as { id: string }).id;
    const t = io(root);
    expect(await main(['label', id, 'perhaps'], t.io)).toBe(1);
    expect(t.err()).toContain('not an option');
  });

  it('bench --json runs on the fake backend without writing files', async () => {
    const t = io(FIXTURE);
    expect(await main(['bench', '-b', 'fake', '--limit', '6', '--no-faithfulness', '--no-write', '--json'], t.io)).toBe(0);
    const r = JSON.parse(t.out()) as { backend: string; items: number; harnessOnly: boolean; metrics: { n: number } };
    expect(r).toMatchObject({ backend: 'fake', items: 6, harnessOnly: true });
    expect(r.metrics.n).toBe(6);
  });

  it('bench writes <backend>.json and .md to --out', async () => {
    const out = await mkdtemp(join(tmpdir(), 'glassbox-bench-'));
    const t = io(FIXTURE);
    expect(await main(['bench', '-b', 'fake', '--limit', '8', '--faith-limit', '1', '--out', out, '-q'], t.io)).toBe(0);
    expect(JSON.parse(await readFile(join(out, 'fake.json'), 'utf8')).items).toBe(8);
    expect(await readFile(join(out, 'fake.md'), 'utf8')).toContain('| all | 8 |');
  });
});
