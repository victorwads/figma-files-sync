import { chromium, type Browser, type BrowserContext } from "playwright";
import { open } from "node:fs/promises";
import { AuthStore, addAuthCookie } from "./auth.js";
import type { ProgressReporter } from "./progress.js";

export interface NativeDownloader {
  download(key: string, destination: string): Promise<void>;
  close(): Promise<void>;
}
export interface DownloadOptions {
  headed?: boolean;
  timeoutMs?: number;
  delayMs?: number;
  onProgress?: ProgressReporter;
}
/** UI adapter extracted from the original exporter. Keep Figma-specific selectors here. */
export class PlaywrightDownloader implements NativeDownloader {
  private browser?: Browser;
  private context?: BrowserContext;
  private lastDownload = 0;
  constructor(
    private readonly auth: AuthStore,
    private readonly options: DownloadOptions = {},
  ) {}
  private async ready(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.options.onProgress?.({
      phase: "auth",
      message: "Loading saved Figma browser authentication",
    });
    if (!(await this.auth.hasSession()) && !process.env.FIGMA_AUTH_COOKIE)
      throw new Error("Browser login required. Run figma-files-sync login.");
    this.options.onProgress?.({
      phase: "browser",
      message:
        "Opening Chromium (" +
        (this.options.headed ? "visible" : "headless") +
        ")",
    });
    this.browser = await chromium.launch({ headless: !this.options.headed });
    this.context = await this.browser.newContext({
      locale: "en-US",
      acceptDownloads: true,
      ...((await this.auth.hasSession())
        ? { storageState: this.auth.sessionPath }
        : {}),
    });
    if (process.env.FIGMA_AUTH_COOKIE)
      await addAuthCookie(this.context, process.env.FIGMA_AUTH_COOKIE);
    return this.context;
  }
  async download(key: string, destination: string): Promise<void> {
    const context = await this.ready();
    const delay =
      Math.max(10_000, this.options.delayMs ?? 10_000) -
      (Date.now() - this.lastDownload);
    if (delay > 0) {
      this.options.onProgress?.({
        phase: "download",
        message:
          "Waiting " + Math.ceil(delay / 1000) + "s between native downloads",
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const page = await context.newPage();
    const timeout = this.options.timeoutMs ?? 180_000;
    page.setDefaultTimeout(timeout);
    try {
      this.options.onProgress?.({
        phase: "browser",
        message:
          "Opening Figma editor for " +
          key +
          " (timeout " +
          Math.round(timeout / 1000) +
          "s)",
      });
      await page.goto(
        "https://www.figma.com/design/" + encodeURIComponent(key),
        { waitUntil: "domcontentloaded", timeout },
      );
      if (/\/(login|signup)(?:\/|$)/.test(new URL(page.url()).pathname))
        throw new Error("Browser session expired. Run figma-files-sync login.");
      await page
        .getByRole("button", { name: "Close", exact: true })
        .click({ timeout: 2000 })
        .catch(() => {});
      this.options.onProgress?.({
        phase: "browser",
        message: "Waiting for editor / opening File menu for " + key,
      });
      await page.locator("[data-tooltip='main-menu']").click();
      await page.locator("[aria-controls^='mainMenu.file-menu']").click();
      const action = page.getByText("Save local copy…", { exact: true });
      this.options.onProgress?.({
        phase: "download",
        message:
          "Requesting Save local copy; waiting for Figma to generate " +
          key +
          ".fig",
      });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout }),
        action.click(),
      ]);
      if (!download.suggestedFilename().toLowerCase().endsWith(".fig"))
        throw new Error(
          "Figma returned a non-.fig document; only Figma Design is supported.",
        );
      this.options.onProgress?.({
        phase: "download",
        message:
          "Download started for " + key + "; waiting for transfer to finish",
      });
      await download.saveAs(destination);
      if (await download.failure())
        throw new Error("Figma native download failed.");
      this.options.onProgress?.({
        phase: "download",
        message: "Transfer finished; validating native file for " + key,
      });
      await verifyNativeFile(destination);
      await this.auth.saveSession(context);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new Error(
          "Figma UI/download timed out. Check session, export permissions, desktop-app link settings, or retry with --headed / --timeout. No export restrictions are bypassed.",
        );
      throw error;
    } finally {
      this.lastDownload = Date.now();
      await page.close();
    }
  }
  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
  }
}
export async function verifyNativeFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, 512, 0);
    const text = head.subarray(0, bytesRead).toString("utf8").trimStart();
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      text.startsWith("<") ||
      text.startsWith("{") ||
      text.startsWith("[")
    )
      throw new Error(
        "Download is empty or contains an error response, not a native .fig file.",
      );
    // Proprietary container signatures may evolve. Sanity checks are not full format validation.
  } finally {
    await handle.close();
  }
}
