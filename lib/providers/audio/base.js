/**
 * AudioProvider interface.
 *
 * getPlayableSource(track) -> Promise<AudioSource>
 *
 * AudioSource (success):
 *   { available: true, url, mimeType, durationMs, expiresAt, provider }
 *
 * AudioSource (failure):
 *   { available: false, reason, stage }
 *
 * stage indicates WHERE it failed: resolve | fetch | transcode | validate
 * The player and application logic never touch provider internals.
 */

class AudioProvider {
  get name() { return "base"; }

  /**
   * @param {NormalizedTrack} track - { id, title, artist, album, albumArt, durationMs, externalId, source }
   * @returns {Promise<AudioSource>}
   */
  async getPlayableSource(track) {
    throw new Error("not implemented");
  }

  /**
   * Optional: verify the provider can operate (network, credentials, binaries).
   * @returns {Promise<{ok: boolean, detail: string}>}
   */
  async checkHealth() {
    return { ok: true, detail: "no check implemented" };
  }
}

module.exports = { AudioProvider };
