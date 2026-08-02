import { chromium } from 'playwright'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const baseUrl = required('TURN_SERVER_URL').replace(/\?.*$/, '')
const username = required('TURN_USERNAME')
const credential = required('TURN_PASSWORD')
const outputPath = process.env.TURN_EVIDENCE_PATH?.trim() || 'external-turn-evidence.json'

const transports = ['udp', 'tcp']
const evidence = {
  started_at: new Date().toISOString(),
  turn_server: baseUrl.replace(/^(turns?:)[^@]*@/, '$1[redacted]@'),
  checks: {}
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  for (const transport of transports) {
    const result = await page.evaluate(
      async ({ url, username, credential, transport }) => {
        const timeout = (promise, milliseconds, label) =>
          Promise.race([
            promise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
            )
          ])

        const waitForIceComplete = (pc) => {
          if (pc.iceGatheringState === 'complete') return Promise.resolve()
          return new Promise((resolve) => {
            const listener = () => {
              if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', listener)
                resolve()
              }
            }
            pc.addEventListener('icegatheringstatechange', listener)
          })
        }

        const pc1 = new RTCPeerConnection({
          iceServers: [{ urls: `${url}?transport=${transport}`, username, credential }],
          iceTransportPolicy: 'relay'
        })
        const pc2 = new RTCPeerConnection({
          iceServers: [{ urls: `${url}?transport=${transport}`, username, credential }],
          iceTransportPolicy: 'relay'
        })

        try {
          const receivedByPeer = new Promise((resolve) => {
            pc2.addEventListener('datachannel', (event) => {
              event.channel.addEventListener('message', (message) => {
                event.channel.send(`echo:${message.data}`)
                resolve(message.data)
              })
            })
          })
          const channel = pc1.createDataChannel(`vesper-turn-${transport}`)
          const opened = new Promise((resolve) => channel.addEventListener('open', resolve, { once: true }))
          const echoed = new Promise((resolve) =>
            channel.addEventListener('message', (event) => resolve(event.data), { once: true })
          )

          await pc1.setLocalDescription(await pc1.createOffer())
          await timeout(waitForIceComplete(pc1), 20_000, `${transport} offer ICE gathering`)
          await pc2.setRemoteDescription(pc1.localDescription)
          await pc2.setLocalDescription(await pc2.createAnswer())
          await timeout(waitForIceComplete(pc2), 20_000, `${transport} answer ICE gathering`)
          await pc1.setRemoteDescription(pc2.localDescription)
          await timeout(opened, 25_000, `${transport} relay data channel`)

          const offerCandidates = pc1.localDescription.sdp
            .split(/\r?\n/)
            .filter((line) => line.startsWith('a=candidate:'))
          const answerCandidates = pc2.localDescription.sdp
            .split(/\r?\n/)
            .filter((line) => line.startsWith('a=candidate:'))
          const candidates = [...offerCandidates, ...answerCandidates]
          if (candidates.length === 0 || candidates.some((line) => !line.includes(' typ relay '))) {
            throw new Error(`Expected relay-only ICE candidates for ${transport}`)
          }

          const nonce = `vesper-external-turn-${transport}-${Date.now()}-${Math.random().toString(16).slice(2)}`
          channel.send(nonce)
          const [peerMessage, echoMessage] = await timeout(
            Promise.all([receivedByPeer, echoed]),
            10_000,
            `${transport} relayed payload`
          )
          if (peerMessage !== nonce || echoMessage !== `echo:${nonce}`) {
            throw new Error(`Relayed ${transport} payload mismatch`)
          }

          const candidateSummary = []
          for (const pc of [pc1, pc2]) {
            const stats = await pc.getStats()
            for (const report of stats.values()) {
              if (report.type !== 'local-candidate' || report.candidateType !== 'relay') continue
              candidateSummary.push({
                protocol: report.protocol?.toLowerCase(),
                relay_protocol: report.relayProtocol?.toLowerCase(),
                address_family: report.address?.includes(':') ? 'ipv6' : 'ipv4',
                type: report.candidateType
              })
            }
          }
          if (
            candidateSummary.length === 0 ||
            candidateSummary.some((candidate) => candidate.relay_protocol !== transport)
          ) {
            throw new Error(`TURN control transport was not proven as ${transport}`)
          }

          return {
            status: 'passed',
            candidate_count: candidateSummary.length,
            candidates: candidateSummary,
            payload_round_trip: 'passed'
          }
        } finally {
          pc1.close()
          pc2.close()
        }
      },
      { url: baseUrl, username, credential, transport }
    )
    evidence.checks[transport] = result
  }
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  evidence.completed_at = new Date().toISOString()
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  )
  await browser.close()
}

console.log(JSON.stringify(evidence, null, 2))
