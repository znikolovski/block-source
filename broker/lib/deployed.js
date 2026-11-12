'use strict';

const { gitBlobSha } = require('./crypto');
const { previewability } = require('./blocks');

const DEPLOYED_TTL = 60;

/**
 * Verifies that the code served by the origin is the branch head:
 * computes the git blob SHA of the deployed file and compares it with GitHub's blob SHA.
 */
async function deployedCheck(gh, deps, {
  org, site, block, ref,
}) {
  const host = previewability(ref, site, org);
  if (!host.previewable) return { state: 'unknown', reason: host.reason };
  const path = `blocks/${block}/${block}.js`;
  return deps.cache.value(`dep-${org}-${site}-${ref}-${block}`, DEPLOYED_TTL, async () => {
    const meta = await gh.getContent(path, ref);
    if (!meta || !meta.sha) return { state: 'unknown', reason: 'The block has no JavaScript file on this branch.' };
    const url = `https://${ref.toLowerCase()}--${site}--${org}.aem.live/${path}`;
    let res;
    try {
      res = await deps.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    } catch {
      return {
        state: 'not-deployed', url, githubSha: meta.sha, reason: 'The origin could not be reached.',
      };
    }
    if (!res.ok) {
      return {
        state: 'not-deployed', url, githubSha: meta.sha, httpStatus: res.status,
      };
    }
    const deployedSha = gitBlobSha(Buffer.from(await res.arrayBuffer()));
    return {
      state: deployedSha === meta.sha ? 'in-use' : 'out-of-sync',
      url,
      githubSha: meta.sha,
      deployedSha,
      checkedAt: new Date(deps.now()).toISOString(),
    };
  });
}

module.exports = { deployedCheck };
