import { Shield, Star, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface AuthFeature {
  icon: LucideIcon
  label: string
  description: string
}

interface AuthMetric {
  value: string
  label: string
}

interface Props {
  centered?: boolean
  formEyebrow?: string
  formTitle: string
  formDescription: string
  panelEyebrow: string
  panelTitle: string
  panelDescription: string
  features: AuthFeature[]
  metrics?: AuthMetric[]
  children: ReactNode
}

export default function AuthShell({
  centered = false,
  formEyebrow,
  formTitle,
  formDescription,
  panelEyebrow,
  panelTitle,
  panelDescription,
  features,
  metrics = [],
  children
}: Props): React.JSX.Element {
  return (
    <div className="vesper-auth-screen">
      {!centered && (
        <div className="vesper-auth-background" aria-hidden="true">
          <div className="vesper-auth-background-orb vesper-auth-background-orb-primary" />
          <div className="vesper-auth-background-orb vesper-auth-background-orb-secondary" />
          <div className="vesper-auth-background-cloud vesper-auth-background-cloud-primary" />
          <div className="vesper-auth-background-cloud vesper-auth-background-cloud-secondary" />
          <div className="vesper-auth-background-grid" />
        </div>
      )}

      <div className={`vesper-auth-layout animate-scale-in${centered ? ' vesper-auth-layout-centered' : ''}`}>
        {!centered && (
          <aside className="vesper-auth-panel glass-card">
            <div className="vesper-auth-brand">
              <div className="vesper-auth-brand-mark">
                <Star className="w-5 h-5" />
              </div>
              <div>
                <div className="vesper-auth-brand-name">Vesper</div>
                <div className="vesper-auth-brand-tag">Encrypted chat that stays in sync</div>
              </div>
            </div>

            <div className="vesper-auth-panel-copy">
              <div className="vesper-auth-panel-eyebrow">{panelEyebrow}</div>
              <h1 className="vesper-auth-panel-title">{panelTitle}</h1>
              <p className="vesper-auth-panel-description">{panelDescription}</p>
            </div>

            {metrics.length > 0 && (
              <div className="vesper-auth-metrics">
                {metrics.map((metric) => (
                  <div key={metric.label} className="vesper-auth-metric">
                    <div className="vesper-auth-metric-value">{metric.value}</div>
                    <div className="vesper-auth-metric-label">{metric.label}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="vesper-auth-feature-list">
              {features.map((feature) => {
                const Icon = feature.icon
                return (
                  <div key={feature.label} className="vesper-auth-feature">
                    <div className="vesper-auth-feature-icon">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="vesper-auth-feature-label">{feature.label}</div>
                      <div className="vesper-auth-feature-description">{feature.description}</div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="vesper-auth-panel-footer">
              <Shield className="w-4 h-4" />
              Your recovery key protects message history across devices.
            </div>
          </aside>
        )}

        <section className={`vesper-auth-form-card${centered ? '' : ' glass-card'}`}>
          <div className="vesper-auth-form-header">
            <div className="vesper-auth-form-logo">
              <Star className="w-6 h-6" />
              <span className="vesper-auth-form-logo-name">Vesper</span>
            </div>
            {formEyebrow ? <div className="vesper-auth-form-kicker">{formEyebrow}</div> : null}
            <h2 className="vesper-auth-form-title">{formTitle}</h2>
            <p className="vesper-auth-form-description">{formDescription}</p>
          </div>
          {children}
        </section>
      </div>
    </div>
  )
}
