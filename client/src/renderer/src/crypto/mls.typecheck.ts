import type { ClientState, MLSMessage } from 'ts-mls'

import { initCipherSuite, processCommitMessage } from './mls'

type PublicCommitMessage = Extract<MLSMessage, { wireformat: 'mls_public_message' }>

declare const state: ClientState
declare const wrappedCommit: PublicCommitMessage

void processCommitMessage(state, new Uint8Array())
void initCipherSuite()

async function regressionGuard(): Promise<void> {
  const cs = await initCipherSuite()
  void cs

  const wrapper: PublicCommitMessage = wrappedCommit
  void wrapper

  // This is the exact bug we hit. The nested payload must stay type-invalid
  // anywhere we expect the full MLS public-message wrapper.
  // @ts-expect-error process helpers must use the full wrapped MLS message
  const invalidWrapper: PublicCommitMessage = wrappedCommit.publicMessage
  void invalidWrapper
}

void regressionGuard()
