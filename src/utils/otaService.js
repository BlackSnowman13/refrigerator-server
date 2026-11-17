const https = require('https');
const logger = require('./logger');

class OTAService {
  constructor() {
    this.repo = process.env.GITHUB_REPO || 'BlackSnowman13/refridgerator_esp32';
    this.token = process.env.GITHUB_TOKEN || '';
    this.cachedRelease = null;
    this.cacheTimestamp = 0;
    this.cacheTtlMs = 60 * 1000; // 60 seconds cache to avoid GitHub rate limits
  }

  getHeaders(accept = 'application/vnd.github+json', includeAuth = true) {
    const headers = {
      'User-Agent': 'ZaZen-Refrigerator-Server',
      'Accept': accept,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    const token = process.env.GITHUB_TOKEN || this.token;
    if (includeAuth && token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  fetchJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: this.getHeaders('application/vnd.github+json', true) }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`Invalid JSON from GitHub API: ${err.message}`));
            }
          } else {
            reject(new Error(`GitHub API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy(new Error('GitHub API request timeout'));
      });
    });
  }

  async getLatestRelease(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cachedRelease && (now - this.cacheTimestamp < this.cacheTtlMs)) {
      return this.cachedRelease;
    }

    const repo = process.env.GITHUB_REPO || this.repo;
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await this.fetchJson(url);

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const binAsset =
      assets.find((a) => a.name === 'refrigerator_app.bin') ||
      assets.find((a) => a.name && a.name.endsWith('.bin')) ||
      null;

    const info = {
      tagName: release.tag_name,
      releaseName: release.name || release.tag_name,
      publishedAt: release.published_at,
      notes: release.body || '',
      asset: binAsset
        ? {
            id: binAsset.id,
            name: binAsset.name,
            size: binAsset.size,
            apiUrl: binAsset.url
          }
        : null
    };

    this.cachedRelease = info;
    this.cacheTimestamp = now;
    return info;
  }

  normalizeVersion(ver) {
    if (!ver || typeof ver !== 'string') return '';
    return ver.trim().replace(/^v/i, '');
  }

  isUpdateAvailable(currentVersion, latestVersion) {
    if (!latestVersion) return false;
    if (!currentVersion || currentVersion === 'unknown') return true;
    const cur = this.normalizeVersion(currentVersion);
    const lat = this.normalizeVersion(latestVersion);
    return cur !== lat;
  }

  async checkUpdateForVersion(currentVersion, forceRefresh = false) {
    const latest = await this.getLatestRelease(forceRefresh);
    const updateAvailable = Boolean(
      latest.asset && this.isUpdateAvailable(currentVersion, latest.tagName)
    );

    return {
      updateAvailable,
      currentVersion: currentVersion || 'unknown',
      latestVersion: latest.tagName,
      releaseName: latest.releaseName,
      publishedAt: latest.publishedAt,
      notes: latest.notes,
      assetName: latest.asset ? latest.asset.name : null,
      assetSize: latest.asset ? latest.asset.size : null
    };
  }

  async streamLatestBinary(res) {
    const latest = await this.getLatestRelease(true);
    if (!latest.asset) {
      res.status(404).json({ error: 'No .bin firmware asset found in latest GitHub release' });
      return;
    }

    const repo = process.env.GITHUB_REPO || this.repo;
    const assetApiUrl = `https://api.github.com/repos/${repo}/releases/assets/${latest.asset.id}`;

    const streamFromUrl = (targetUrl, isRedirect = false, redirectDepth = 0) => {
      if (redirectDepth > 5) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Too many redirects while fetching firmware asset' });
        }
        return;
      }

      // IMPORTANT: Do not send GitHub Authorization header to redirected S3/Fastly URL
      const headers = isRedirect
        ? { 'User-Agent': 'ZaZen-Refrigerator-Server', 'Accept': 'application/octet-stream' }
        : this.getHeaders('application/octet-stream', true);

      const req = https.get(targetUrl, { headers }, (upstreamRes) => {
        if (
          upstreamRes.statusCode >= 300 &&
          upstreamRes.statusCode < 400 &&
          upstreamRes.headers.location
        ) {
          upstreamRes.resume();
          streamFromUrl(upstreamRes.headers.location, true, redirectDepth + 1);
          return;
        }

        if (upstreamRes.statusCode !== 200) {
          let errBody = '';
          upstreamRes.on('data', (c) => { errBody += c; });
          upstreamRes.on('end', () => {
            logger.error(`GitHub asset download failed (${upstreamRes.statusCode}): ${errBody.slice(0, 200)}`);
            if (!res.headersSent) {
              res.status(upstreamRes.statusCode).json({
                error: `Failed to download firmware asset from GitHub (HTTP ${upstreamRes.statusCode})`
              });
            }
          });
          return;
        }

        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${latest.asset.name}"`);
        if (upstreamRes.headers['content-length']) {
          res.setHeader('Content-Length', upstreamRes.headers['content-length']);
        } else if (latest.asset.size) {
          res.setHeader('Content-Length', String(latest.asset.size));
        }

        upstreamRes.pipe(res);
      });

      req.on('error', (err) => {
        logger.error('Error streaming firmware binary from GitHub:', err);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Upstream stream error' });
        } else {
          res.destroy(err);
        }
      });
    };

    streamFromUrl(assetApiUrl, false, 0);
  }
}

module.exports = new OTAService();
