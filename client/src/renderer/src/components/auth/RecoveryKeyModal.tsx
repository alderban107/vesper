import { useState } from 'react'
import { ShieldCheck, Copy, Check } from 'lucide-react'

interface Props {
  mnemonic: string
  onConfirm: () => void
}

export default function RecoveryKeyModal({ mnemonic, onConfirm }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const words = mnemonic.split(' ')

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(mnemonic)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div data-testid="recovery-modal" className="glass-card rounded-2xl p-6 w-[480px] animate-scale-in">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Recovery Key</h2>
            <p className="text-text-faint text-xs">Save this somewhere safe</p>
          </div>
        </div>

        <p className="text-text-muted text-sm mb-4">
          This is the only way to recover your encrypted messages if you lose access to your account.
          It cannot be shown again.
        </p>

        <div className="bg-bg-base/50 rounded-xl p-4 mb-4 grid grid-cols-4 gap-2 border border-border">
          {words.map((word, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-text-faintest text-xs w-5 text-right">{i + 1}.</span>
              <span className="text-text-primary text-sm font-mono">{word}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={handleCopy}
            className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-muted hover:text-text-primary text-sm rounded-lg transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-success" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy to clipboard
              </>
            )}
          </button>
        </div>

        <label className="flex items-center gap-2.5 mb-4 cursor-pointer group">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="rounded border-border accent-accent"
          />
          <span className="text-text-muted text-sm group-hover:text-text-secondary transition-colors">
            I have saved my recovery key in a safe place
          </span>
        </label>

        <button
          onClick={onConfirm}
          disabled={!confirmed}
          className="w-full glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold py-2.5 rounded-lg transition-all"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
