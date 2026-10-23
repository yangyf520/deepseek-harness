/**
 * Tenant-scoped browse backend for the directory-picker seam: wraps the stock
 * BrowseDirectoryPicker so an authenticated tenant's in-app picker is rooted
 * at $DSH_HOME/users/<tenantId>/ — the listing's home anchor pins the
 * dialog's breadcrumb there, and listings or folder creation outside that
 * root are refused. Without a tenant context (single-user mode) every
 * primitive passes through the stock backend unchanged.
 */

import { relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker, { fullyQualified } from '@deepseek-ai/dsh-host-directory-picker-browse'
import type { Config } from '@deepseek-ai/dsh-host-directory-picker-browse'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryListing, DirectoryPickerBrowseCapability, DirectoryPickerErrorCode,
} from '@deepseek-ai/dsh-host-directory-picker'
import { currentTenant, tenantUserRoot } from './index.ts'

/** True when `target` is `root` itself or under it. */
function underOrEqual(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return !rel.startsWith('..')
}

/**
 * The `ctx.directoryPicker` browse implementation scoped to the browsing
 * tenant: the stock backend's capability wrapped with a tenant-root fence.
 */
export default class TenantBrowsePicker extends BrowseDirectoryPicker {
  private readonly stock: DirectoryPickerBrowseCapability
  private tenantCapability: DirectoryPickerBrowseCapability | undefined

  /**
   * @param ctx - Host context the stock backend registers under.
   * @param config - stock browse configuration (maxEntries).
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const capability = super.capability()
    if (capability.kind !== 'browse') {
      throw new Error('TenantBrowsePicker wraps the browse capability; the stock backend served otherwise')
    }
    this.stock = capability
  }

  /**
   * The tenant-scoped browse capability.
   * @returns the stable wrapped capability object.
   */
  override capability(): DirectoryPickerBrowseCapability {
    this.tenantCapability ??= {
      kind: 'browse',
      list: (path, signal) => this.tenantList(path, signal),
      createDirectory: (path, name) => this.tenantCreateDirectory(path, name),
    }
    return this.tenantCapability
  }

  /**
   * List one level, fenced to the tenant root when one is bound.
   * @param path - absolute directory to list; absent lists the tenant root.
   * @param signal - caller lifetime, forwarded to the stock backend.
   * @returns the stock listing with its home anchor pinned to the tenant root.
   */
  private async tenantList(path: string | undefined, signal: AbortSignal | undefined): Promise<DirectoryListing> {
    const tenant = currentTenant()
    if (tenant === undefined) return this.stock.list(path, signal)
    const root = tenantUserRoot(tenant.tenantId)
    const listing = await this.stock.list(this.fence(path ?? root, root, 'directory-unreadable'), signal)
    return { ...listing, home: root }
  }

  /**
   * Create one child directory, fenced to the tenant root when one is bound.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  private tenantCreateDirectory(path: string, name: string): Promise<string> {
    const tenant = currentTenant()
    if (tenant === undefined) return this.stock.createDirectory(path, name)
    const root = tenantUserRoot(tenant.tenantId)
    return this.stock.createDirectory(this.fence(path, root, 'directory-create-failed'), name)
  }

  /**
   * Resolve `path` under the tenant `root`, refusing escapes.
   * @param path - the operator-supplied path.
   * @param root - the tenant's browsing root.
   * @param code - the seam failure code of the refusing verb.
   * @returns the resolved path for the stock backend.
   */
  private fence(path: string, root: string, code: DirectoryPickerErrorCode): string {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError(code, path, `cannot use "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    if (underOrEqual(target, root)) return target
    throw new DirectoryPickerError(code, path, `cannot open "${path}": only directories under ${root} are selectable`)
  }
}
