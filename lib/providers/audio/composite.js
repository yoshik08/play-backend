/**
 * CompositeAudioProvider — tries providers in order, returns first success.
 *
 * Default chain: youtube (full track, best-effort) -> spotify-preview (30s, reliable).
 * If youtube is IP-blocked, spotify preview ensures SOMETHING plays.
 *
 * The player never knows which provider served the audio.
 */
const { AudioProvider } = require("./base");

class CompositeAudioProvider extends AudioProvider {
  get name() { return "composite"; }

  /**
   * @param {AudioProvider[]} providers - in priority order
   */
  constructor(providers) {
    super();
    this.providers = providers;
  }

  async getPlayableSource(track) {
    const errors = [];
    for (const p of this.providers) {
      try {
        const src = await p.getPlayableSource(track);
        if (src.available) {
          src.providerChain = this.providers.map((x) => x.name);
          return src;
        }
        errors.push(`${p.name}: ${src.reason} [${src.stage}]`);
      } catch (e) {
        errors.push(`${p.name}: threw ${e.message.slice(0, 100)}`);
      }
    }
    return {
      available: false,
      reason: errors.join(" | ") || "all providers failed",
      stage: "resolve",
    };
  }

  async checkHealth() {
    const results = {};
    for (const p of this.providers) {
      try {
        results[p.name] = await p.checkHealth();
      } catch (e) {
        results[p.name] = { ok: false, detail: e.message };
      }
    }
    const anyOk = Object.values(results).some((r) => r.ok);
    return { ok: anyOk, detail: results };
  }
}

module.exports = { CompositeAudioProvider };
