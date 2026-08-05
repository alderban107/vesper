import { create } from 'zustand'

export type AttachmentTransferErrorKind =
  | 'integrity'
  | 'network'
  | 'unavailable'
  | 'unsupported'

interface AttachmentTransferState {
  errorsByAttachmentId: Record<string, AttachmentTransferErrorKind>
  setError: (attachmentId: string, error: AttachmentTransferErrorKind) => void
  clearError: (attachmentId: string) => void
  reset: () => void
}

export const useAttachmentTransferStore = create<AttachmentTransferState>((set) => ({
  errorsByAttachmentId: {},
  setError: (attachmentId, error) => {
    set((state) => ({
      errorsByAttachmentId: {
        ...state.errorsByAttachmentId,
        [attachmentId]: error
      }
    }))
  },
  clearError: (attachmentId) => {
    set((state) => {
      if (!(attachmentId in state.errorsByAttachmentId)) return state
      const errorsByAttachmentId = { ...state.errorsByAttachmentId }
      delete errorsByAttachmentId[attachmentId]
      return { errorsByAttachmentId }
    })
  },
  reset: () => set({ errorsByAttachmentId: {} })
}))
