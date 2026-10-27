import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebrand } from '../rebrand-upstream.mjs'

test('renames the product, the package scope and issue refs', () => {
  assert.equal(
    rebrand("import x from '@genoffice/xlsx-gateway/a'"),
    "import x from '@selfoffice/xlsx-gateway/a'",
  )
  assert.equal(
    rebrand('GenOffice opens GENOFFICE_HOME (genoffice#12)'),
    'SelfOffice opens SELFOFFICE_HOME (selfoffice#12)',
  )
})

test('keeps identifiers that live inside user documents and the attribution', () => {
  const kept = [
    'GenOfficeStaticFormFills',
    'GenOfficeFormField',
    '_GenOfficeCoverPageEnd',
    'https://genspark.ai/genoffice/redaction/2026',
    '__genoffice_media__',
    '.genoffice-assets.json',
    'https://github.com/genspark-ai/genoffice',
    'GenOffice Gothic KR',
    'Mainfunc, Inc.',
  ]
  for (const text of kept) assert.equal(rebrand(text), text)
  assert.equal(rebrand('GenOffice uses GenOfficeFormField'), 'SelfOffice uses GenOfficeFormField')
})

test('is idempotent', () => {
  const once = rebrand('GenOffice @genoffice/x')
  assert.equal(rebrand(once), once)
})
