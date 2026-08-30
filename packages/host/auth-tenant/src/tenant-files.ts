/** Per-tenant credentials and settings documents under `$DSH_HOME/users/<tenant>/`. */

import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

const CREDENTIALS_FILENAME = '.credentials.yaml'
const SETTINGS_FILENAME = 'settings.yaml'

/** OAuth app secrets stay on the deployment-wide credentials document. */
export const GLOBAL_CREDENTIAL_REF_PREFIX = 'AUTH_'

/** Settings namespaces shared by every authenticated user. */
export const GLOBAL_SETTINGS_NAMESPACES = new Set(['auth-channels'])

/** `$DSH_HOME/users/`. */
export function usersRoot(): string {
  return dshHomePath('users')
}

/** `$DSH_HOME/users/<tenant>/`. */
export function tenantRoot(tenantId: string): string {
  return dshHomePath('users', tenantId)
}

/** `$DSH_HOME/users/<tenant>/workspace`. */
export function tenantWorkspaceDir(tenantId: string): string {
  return dshHomePath('users', tenantId, 'workspace')
}

function credentialsPath(tenantId: string): string {
  return join(tenantRoot(tenantId), CREDENTIALS_FILENAME)
}

function settingsPath(tenantId: string): string {
  return join(tenantRoot(tenantId), SETTINGS_FILENAME)
}

function isENOENT(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function readYamlDoc(tenantId: string, path: string, empty: string): Promise<Document> {
  await mkdir(tenantRoot(tenantId), { recursive: true })
  try {
    return parseDocument(await readFile(path, 'utf8'))
  } catch (error: unknown) {
    if (isENOENT(error)) return parseDocument(empty)
    throw error
  }
}

async function writeYamlDoc(tenantId: string, path: string, doc: Document): Promise<void> {
  await mkdir(tenantRoot(tenantId), { recursive: true })
  await withFileLock(path, async () => {
    await writeFileAtomic(path, String(doc), { mode: 0o600, dirMode: 0o700 })
  })
}

function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refsSection(doc: Document): Record<string, string> {
  const root = doc.toJS() as unknown
  if (!isMapLike(root)) return {}
  const refs = root.refs
  if (!isMapLike(refs)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

async function readCredentialsDoc(tenantId: string): Promise<Document> {
  return readYamlDoc(tenantId, credentialsPath(tenantId), 'version: 1\nrefs: {}\n')
}

async function writeCredentialsDoc(tenantId: string, doc: Document): Promise<void> {
  await writeYamlDoc(tenantId, credentialsPath(tenantId), doc)
}

/** Read one tenant credential ref value, if configured. */
export async function readTenantCredential(tenantId: string, ref: string): Promise<string | undefined> {
  const doc = await readCredentialsDoc(tenantId)
  return refsSection(doc)[ref]
}

/** Describe one tenant credential ref for the wire API. */
export async function describeTenantCredential(tenantId: string, ref: string): Promise<CredentialInfo> {
  const value = await readTenantCredential(tenantId, ref)
  return value === undefined
    ? { configured: false, writable: true }
    : { configured: true, source: 'file', writable: true }
}

/** Store one tenant credential ref. */
export async function setTenantCredential(tenantId: string, ref: string, value: string): Promise<void> {
  const doc = await readCredentialsDoc(tenantId)
  if (!doc.has('version')) doc.set('version', 1)
  if (!doc.has('refs')) doc.set('refs', {})
  doc.setIn(['refs', ref], value)
  await writeCredentialsDoc(tenantId, doc)
}

/** Remove one tenant credential ref. */
export async function unsetTenantCredential(tenantId: string, ref: string): Promise<void> {
  const doc = await readCredentialsDoc(tenantId)
  if (doc.hasIn(['refs', ref])) {
    doc.deleteIn(['refs', ref])
    await writeCredentialsDoc(tenantId, doc)
  }
}

async function readSettingsDoc(tenantId: string): Promise<Document> {
  return readYamlDoc(tenantId, settingsPath(tenantId), '{}\n')
}

async function writeSettingsDoc(tenantId: string, doc: Document): Promise<void> {
  await writeYamlDoc(tenantId, settingsPath(tenantId), doc)
}

function sectionFromSettingsRoot(root: unknown, ns: string): Record<string, unknown> | undefined {
  if (!isMapLike(root)) return undefined
  const section = root[ns]
  if (!isMapLike(section)) return undefined
  return section
}

/** Read one namespace section from the tenant settings document. */
export async function readTenantSettingsSection(tenantId: string, ns: string): Promise<Record<string, unknown> | undefined> {
  const doc = await readSettingsDoc(tenantId)
  return sectionFromSettingsRoot(doc.toJS() as unknown, ns)
}

/** Synchronous tenant settings read for `ctx.settings.get()` overlay. */
export function readTenantSettingsSectionSync(tenantId: string, ns: string): Record<string, unknown> | undefined {
  try {
    const doc = parseDocument(readFileSync(settingsPath(tenantId), 'utf8'))
    return sectionFromSettingsRoot(doc.toJS() as unknown, ns)
  } catch (error: unknown) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

/** Replace one namespace section in the tenant settings document. */
export async function replaceTenantSettingsSection(tenantId: string, ns: string, section: Record<string, unknown>): Promise<void> {
  const doc = await readSettingsDoc(tenantId)
  doc.set(ns, section)
  await writeSettingsDoc(tenantId, doc)
}

/** Merge a patch into one tenant settings namespace section. */
export async function patchTenantSettingsSection(tenantId: string, ns: string, patch: Record<string, unknown>): Promise<void> {
  const existing = (await readTenantSettingsSection(tenantId, ns)) ?? {}
  await replaceTenantSettingsSection(tenantId, ns, { ...existing, ...patch })
}

export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Apply one path op to a detached section (mirrors `dsh-settings` mutate semantics). */
function applySettingsPathOp(section: Record<string, unknown>, op: SettingsPathOp): Record<string, unknown> {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) {
      throw new TypeError('settings mutate: setting the section root requires a plain object')
    }
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return { ...section, [head]: applySettingsPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applySettingsPathOp(child, { ...op, path: rest }) }
}

/** Apply ordered path ops to one settings section (tenant document mirror of host mutate). */
export function applySettingsPathOps(section: Record<string, unknown>, ops: readonly SettingsPathOp[]): Record<string, unknown> {
  return ops.reduce((current, op) => applySettingsPathOp(current, op), { ...section })
}

/** Apply path ops to one tenant settings namespace section. */
export async function mutateTenantSettingsSection(
  tenantId: string,
  ns: string,
  ops: readonly SettingsPathOp[],
): Promise<void> {
  const existing = (await readTenantSettingsSection(tenantId, ns)) ?? {}
  await replaceTenantSettingsSection(tenantId, ns, applySettingsPathOps(existing, ops))
}

/** Whether a credential ref is owned by the deployment-wide store (OAuth app secrets). */
export function isGlobalCredentialRef(ref: string): boolean {
  return ref.startsWith(GLOBAL_CREDENTIAL_REF_PREFIX)
}

export type { CredentialRef }
