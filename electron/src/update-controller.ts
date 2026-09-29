/**
 * Update orchestration: check → download → verify → hand off to the installer.
 *
 * State is pushed to the update window; the controller never installs anything it has
 * not verified, and never trusts a manifest that is not newer than the running build.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { UpdateState } from './constants.ts'
import { updatesDir } from './paths.ts'
import {
  discardInstaller,
  downloadInstaller,
  fetchManifest,
  installerFileName,
  isNewer,
  launchInstaller,
  manifestUrl,
  verifyInstaller,
  type UpdateManifest,
} from './update.ts'

export interface UpdateControllerOptions {
  readonly currentVersion: string
  readonly onState: (state: UpdateState) => void
  /** Called when a newer version exists; silent runs use it to open the window. */
  readonly onAvailable: (version: string) => void
  /** Stop the shell and run the verified installer. */
  readonly onInstall: (installerPath: string) => void
}

export class UpdateController {
  private state: UpdateState = { phase: 'idle' }
  private manifest: UpdateManifest | undefined
  private verifiedInstaller: string | undefined
  private inFlight: Promise<void> | undefined

  constructor(private readonly options: UpdateControllerOptions) {}

  get current(): UpdateState {
    return this.state
  }

  private setState(next: UpdateState): void {
    this.state = next
    this.options.onState(next)
  }

  /**
   * Read the manifest and report whether a newer version exists.
   * @param announce - Whether this check may open the update window.
   */
  async check(announce: boolean): Promise<UpdateState> {
    if (this.inFlight !== undefined) return this.state
    const run = async (): Promise<void> => {
      this.setState({ phase: 'checking', message: '正在检查更新…' })
      try {
        const manifest = await fetchManifest(manifestUrl())
        if (!isNewer(manifest.version, this.options.currentVersion)) {
          this.manifest = undefined
          this.setState({
            phase: 'idle',
            version: manifest.version,
            message: `已是最新版本（${this.options.currentVersion}）`,
          })
          return
        }
        this.manifest = manifest
        this.setState({
          phase: 'available',
          version: manifest.version,
          message: `发现新版本 ${manifest.version}`,
        })
        this.options.onAvailable(manifest.version)
      } catch (error) {
        this.setState({
          phase: 'error',
          message: '检查更新失败，请稍后重试。',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.inFlight = run().finally(() => { this.inFlight = undefined })
    await this.inFlight
    void announce
    return this.state
  }

  /** Download the offered version and verify the bytes before anything may install. */
  async download(): Promise<UpdateState> {
    const manifest = this.manifest
    if (manifest === undefined) return this.state
    if (this.verifiedInstaller !== undefined) return this.state
    const destination = join(updatesDir(), installerFileName(manifest.version))
    let lastPercent = -1
    this.setState({ phase: 'downloading', version: manifest.version, percent: 0, message: '正在下载…' })
    try {
      await mkdir(updatesDir(), { recursive: true })
      await downloadInstaller(manifest.entry.url, destination, ({ received, total }) => {
        if (total <= 0) return
        const percent = Math.min(100, Math.floor((received / total) * 100))
        if (percent === lastPercent) return
        lastPercent = percent
        this.setState({ phase: 'downloading', version: manifest.version, percent, message: '正在下载…' })
      })
      this.setState({ phase: 'verifying', version: manifest.version, message: '正在校验签名…' })
      const result = await verifyInstaller(destination, manifest.entry.signature)
      if (!result.ok) {
        await discardInstaller(destination)
        this.setState({
          phase: 'error',
          version: manifest.version,
          message: '下载的安装包签名校验失败，已丢弃。',
          detail: result.reason,
        })
        return this.state
      }
      this.verifiedInstaller = destination
      this.setState({
        phase: 'ready',
        version: manifest.version,
        message: `v${manifest.version} 已就绪，可以安装`,
      })
    } catch (error) {
      await discardInstaller(destination).catch(() => {})
      this.setState({
        phase: 'error',
        version: manifest.version,
        message: '下载或校验失败，请重试。',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    return this.state
  }

  /** Install only what was verified in this process. */
  install(): boolean {
    const installer = this.verifiedInstaller
    if (installer === undefined) return false
    this.setState({ phase: 'ready', message: '正在关闭应用并安装…' })
    this.options.onInstall(installer)
    return true
  }

  /** Reset to "an update exists" so a dismissed window can be reopened. */
  dismiss(): void {
    if (this.manifest === undefined) {
      this.setState({ phase: 'idle', message: '已是最新版本' })
      return
    }
    this.setState({
      phase: this.verifiedInstaller === undefined ? 'available' : 'ready',
      version: this.manifest.version,
      message: this.verifiedInstaller === undefined
        ? `发现新版本 ${this.manifest.version}`
        : `v${this.manifest.version} 已就绪，可以安装`,
    })
  }
}

export { launchInstaller }
