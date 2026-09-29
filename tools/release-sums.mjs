#!/usr/bin/env node
/**
 * The list of what a gate release is, for its owner to sign.
 *
 *   node tools/release-sums.mjs          write release/SHA256SUMS
 *   node tools/release-sums.mjs --check  exit 1 unless it matches the files
 *
 * A gate is code the reader's browser runs, fetched afresh from whoever hosts
 * it, so a compromised host can serve anything. This file names every file a
 * browser runs for this release, with its SHA-256, in the format `sha256sum`
 * reads. Signed offline by the release key — never in CI, where it would fall
 * with the host it is meant to guard against — it lets anyone check a mirror
 * with standard tools and none of ours. See SECURITY.md, "Trusting the gate".
 *
 * What is listed is exactly what the gate loads: its two pages, its
 * stylesheet, its service worker, its modules and the vendored bundle.
 * `tools/e2e.mjs` checks that this set and what the pages actually import are
 * the same, so a new module cannot be left out unnoticed.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release', 'SHA256SUMS')

/** The files a browser runs, as paths relative to the gate's root. */
export async function gateFiles () {
  const inDir = async (dir, ext) =>
    (await readdir(join(ROOT, dir))).filter(name => name.endsWith(ext)).map(name => `${dir}/${name}`)
  return [
    'index.html', 'relay.html', 'sw.js', 'app.css',
    ...await inDir('js', '.js'),
    ...await inDir('vendor', '.js')
  ].sort()
}

/** `sha256sum` output for those files, one line each. */
export async function sums () {
  const lines = []
  for (const path of await gateFiles()) {
    const digest = createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex')
    lines.push(`${digest}  ${path}`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = await sums()
  if (process.argv.includes('--check')) {
    let written = ''
    try { written = await readFile(OUT, 'utf8') } catch {}
    if (written !== wanted) {
      console.error('release/SHA256SUMS does not match the files. Run: node tools/release-sums.mjs')
      process.exit(1)
    }
    console.log('release/SHA256SUMS matches the files.')
  } else {
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, wanted)
    const { GATE_VERSION } = await import('../js/config.js')
    console.log(`Wrote release/SHA256SUMS for gate ${GATE_VERSION}: ${wanted.trim().split('\n').length} files.`)
    console.log('Now sign it, offline, with the release key:')
    console.log('  ssh-keygen -Y sign -f ~/.ssh/spore-release -n spore-gate release/SHA256SUMS')
  }
}
