/**
 * Resolve Pi packages from either npm scope:
 *   @earendil-works/*  — pi 0.74+
 *   @mariozechner/*    — pi 0.73.x
 *
 * Pi loads extensions via jiti from its own install, so these imports
 * resolve against pi's node_modules, not this folder.
 */
async function loadCodingAgent(): Promise<any> {
  try {
    // @ts-ignore optional peer — present on pi 0.74+
    return await import("@earendil-works/pi-coding-agent");
  } catch {
    // @ts-ignore optional peer — present on pi 0.73.x
    return await import("@mariozechner/pi-coding-agent");
  }
}

async function loadPiAi(): Promise<any> {
  try {
    // @ts-ignore optional peer — present on pi 0.74+
    return await import("@earendil-works/pi-ai");
  } catch {
    // @ts-ignore optional peer — present on pi 0.73.x
    return await import("@mariozechner/pi-ai");
  }
}

const coding = await loadCodingAgent();
const ai = await loadPiAi();

export const truncateHead = coding.truncateHead;
export const DEFAULT_MAX_BYTES = coding.DEFAULT_MAX_BYTES;
export const DEFAULT_MAX_LINES = coding.DEFAULT_MAX_LINES;
export const StringEnum = ai.StringEnum;

export type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
