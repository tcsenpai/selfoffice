#!/usr/bin/env node
/**
 * Re-applies the SelfOffice rebrand to what an upstream merge brought in, and
 * flags upstream changes that need a human (anything Genspark-hosted).
 *
 *   node tools/rebrand-upstream.mjs <base> [<tip>]   rewrite files changed between base..tip (default tip upstream/main)
 *   node tools/rebrand-upstream.mjs --report <base> [<tip>]   print the markdown review list, change nothing
 *
 * Idempotent: files already renamed are left alone. Persisted-in-file
 * identifiers and the upstream attribution stay as they are (see PROTECTED):
 * documents written by upstream tools must keep opening.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTECTED = [
  'genspark-ai/genoffice',
  'GenOfficeStaticFormFills',
  'GenOfficeFormField',
  'GenOffice visual signature field: ',
  '_GenOfficeCoverPage',
  'genspark.ai/genoffice/redaction/2026',
  'schemas.genspark.ai/genoffice',
  '__genoffice_media__',
  '.genoffice-assets.json',
  'GenOffice Gothic KR',
  'GenOfficeGothicKR',
  'Mainfunc',
]

const SKIP_PATH =
  /^(LICENSE|NOTICE|LICENSE-UNICODE)(\.|$)|^ee\/|\.(png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|zip|docx|xlsx|pptx|pdf|odt|ods|odp|node|wasm)$/i

/** old brand -> new brand in one string, protected identifiers untouched */
export function rebrand(text) {
  const slots = []
  // placeholder pass, longest first so a prefix never shadows its longer form
  let out = text
  for (const keep of [...PROTECTED].sort((a, b) => b.length - a.length)) {
    out = out.split(keep).join(`\uE000${slots.push(keep) - 1}\uE000`)
  }
  out = out
    .replaceAll('GenOffice', 'SelfOffice')
    .replaceAll('GENOFFICE', 'SELFOFFICE')
    .replaceAll('Genoffice', 'Selfoffice')
    .replaceAll('genoffice', 'selfoffice')
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => slots[Number(i)])
}

/** upstream lines that reintroduce what this fork removed */
const FLAGS = [
  [/genspark(?!-ai\/genoffice|\.ai\/genoffice\/redaction|\.ai\/genoffice)/i, 'mentions Genspark'],
  [/\bgsk[A-Z_a-z]*\b/, 'uses the gsk CLI / gsk helpers'],
  [/analytics|google-analytics|measurement_id/i, 'analytics or telemetry'],
  [/cloud[-_ ]?project|genteam|sspark/i, 'cloud projects / GenTeam'],
  [/login|sign[-_ ]?in|oauth/i, 'sign-in flow (check it is not a hosted account)'],
]

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

export function changedFiles(base, tip) {
  return git('diff', '--name-only', '--diff-filter=AMR', base, tip).split('\n').filter(Boolean)
}

export function report(base, tip) {
  const hits = new Map()
  let file = ''
  for (const line of git('diff', '-U0', base, tip).split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6)
    else if (line.startsWith('+') && !line.startsWith('+++') && !SKIP_PATH.test(file)) {
      for (const [re, why] of FLAGS) {
        if (re.test(line)) {
          const key = `${why}: ${file}`
          hits.set(key, (hits.get(key) ?? 0) + 1)
        }
      }
    }
  }
  const ee = git('diff', '--name-only', base, tip, '--', 'ee').split('\n').filter(Boolean)
  const rows = [...hits].slice(0, 60).map(([k, n]) => `- ${k} (${n} line${n > 1 ? 's' : ''})`)
  if (ee.length)
    rows.unshift(
      `- **ee/ changed upstream (${ee.length} files: ${ee.join(', ')}): NOT merged.** It is under the GenOffice Enterprise License; review whether it changes what the fork may do.`,
    )
  return rows.length ? rows.join('\n') : 'No flagged lines.'
}

/** rewrite the given files in place; returns the ones that changed */
function rewrite(files) {
  const rewritten = []
  for (const file of files) {
    if (SKIP_PATH.test(file) || !existsSync(file)) continue
    const before = readFileSync(file, 'utf8')
    if (before.includes('\u0000')) continue // binary
    const after = rebrand(before)
    if (after !== before) {
      writeFileSync(file, after)
      rewritten.push(file)
    }
  }
  return rewritten
}

/** paths upstream named with the old brand */
function renamePaths() {
  const renamed = []
  for (const file of git('ls-files')
    .split('\n')
    .filter((f) => /genoffice/i.test(f) && !/^ee\//.test(f))) {
    const target = file
      .replace(/GenOffice/g, 'SelfOffice')
      .replace(/GENOFFICE/g, 'SELFOFFICE')
      .replace(/genoffice/g, 'selfoffice')
    if (target !== file && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      execFileSync('git', ['mv', file, target])
      renamed.push(`${file} -> ${target}`)
    }
  }
  return renamed
}

function main(argv) {
  if (argv[0] === '--tree') {
    // whole checkout, used to build the rebranded mirror of upstream (sync-upstream.yml)
    const rewritten = rewrite(git('ls-files').split('\n').filter(Boolean))
    console.log(JSON.stringify({ rewritten: rewritten.length, renamed: renamePaths() }, null, 2))
    return
  }
  const reportOnly = argv[0] === '--report'
  const [base, tip = 'upstream/main'] = reportOnly ? argv.slice(1) : argv
  if (!base) {
    console.error('usage: rebrand-upstream.mjs [--tree | --report <base> [<tip>] | <base> [<tip>]]')
    process.exit(2)
  }
  if (reportOnly) {
    console.log(report(base, tip))
    return
  }
  const rewritten = rewrite(changedFiles(base, tip))
  console.log(JSON.stringify({ rewritten, renamed: renamePaths() }, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
