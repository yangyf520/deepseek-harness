import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-host-auth-gate', [
  'lib/types/index.js',
  'lib/types/invariant.js',
], {
  hostPhase: true,
})