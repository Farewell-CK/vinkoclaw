import type { FeishuEmojiType, EmojiScene, EmojiReactionConfig } from "./types.js";

const DEFAULT_EMOJI_CONFIG: EmojiReactionConfig = {
  defaultEmoji: "OK",
  sceneEmojis: {
    taskQueued: "OK",
    taskCompleted: ["CHECK", "CLAP", "ROCKET", "THUMBSUP"],
    taskFailed: "THINKING",
    approvalPending: "THINKING",
    agentDiscussion: ["THINKING", "OK", "COOL"],
    finalSummary: ["ROCKET", "FIRE", "PARTY", "CHECK"]
  },
  randomMode: true
};

export type { EmojiScene };

export class EmojiSelector {
  private config: EmojiReactionConfig;

  constructor(config?: Partial<EmojiReactionConfig>) {
    this.config = { ...DEFAULT_EMOJI_CONFIG, ...config };
  }

  selectEmoji(scene?: EmojiScene): FeishuEmojiType {
    if (!scene) {
      return this.config.defaultEmoji;
    }

    const sceneEmoji = this.config.sceneEmojis[scene];

    if (!sceneEmoji) {
      return this.config.defaultEmoji;
    }

    if (Array.isArray(sceneEmoji)) {
      if (this.config.randomMode && sceneEmoji.length > 0) {
        const index = Math.floor(Math.random() * sceneEmoji.length);
        const selected = sceneEmoji[index];
        if (selected) {
          return selected;
        }
      }
      const first = sceneEmoji[0];
      return first ?? this.config.defaultEmoji;
    }

    return sceneEmoji;
  }

  getConfig(): EmojiReactionConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<EmojiReactionConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  setRandomMode(enabled: boolean): void {
    this.config.randomMode = enabled;
  }
}

// 全局默认实例
let defaultInstance: EmojiSelector | undefined;

export function getEmojiSelector(): EmojiSelector {
  if (!defaultInstance) {
    defaultInstance = new EmojiSelector();
  }
  return defaultInstance;
}

export function resetEmojiSelector(): void {
  defaultInstance = undefined;
}
