import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  createCliRenderer
} from '@opentui/core'

import { loadPersistedServerUrl } from '../_shared.mjs'
import { VesperChatRuntime, formatScopeLabel } from './chat-runtime.mjs'

const COLORS = {
  appBg: '#08111a',
  panelBg: '#0d1824',
  panelAlt: '#122031',
  text: '#d6e4ee',
  muted: '#8da4b7',
  faint: '#587086',
  border: '#1f3a4d',
  borderFocus: '#56d1b4',
  accent: '#56d1b4',
  accentWarm: '#ffb761',
  danger: '#ff7d7d',
  success: '#7fe0a1'
}

const AUTH_MODES = [
  { key: 'login', name: 'Login', description: 'Use an existing account' },
  { key: 'register', name: 'Register', description: 'Create a new account' },
  { key: 'recover', name: 'Recover', description: 'Restore with your recovery key' }
]

const EMPTY_SERVER_KEY = '__empty_server__'
const DM_SERVER_KEY = '__dms__'

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isNaN(parsed) ? 0 : parsed
}

function sortConversations(conversations) {
  return [...conversations].sort((left, right) => {
    const leftAt = parseTimestamp(left.last_message?.inserted_at || left.inserted_at)
    const rightAt = parseTimestamp(right.last_message?.inserted_at || right.inserted_at)
    return rightAt - leftAt
  })
}

function shortLabel(value, length = 16) {
  if (!value) {
    return 'n/a'
  }

  return value.length > length ? `${value.slice(0, length - 1)}...` : value
}

function timeLabel(value) {
  if (!value) {
    return '--:--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return '--:--'
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatMessageLine(message, currentUserId) {
  const author =
    message.senderId === currentUserId
      ? 'you'
      : message.senderUsername || shortLabel(message.senderId)

  const flags = []
  if (message.encrypted) {
    flags.push('e2ee')
  }
  if (message.decryptionFailed) {
    flags.push('pending')
  }

  const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : ''
  return `[${timeLabel(message.insertedAt)}] ${author}${suffix}\n${message.content}`
}

function formatConversationName(conversation, currentUserId) {
  if (conversation.name) {
    return conversation.name
  }

  const others = conversation.participants
    .filter((participant) => participant.user_id !== currentUserId)
    .map((participant) => participant.user.username)

  return others.length > 0 ? others.join(', ') : 'Direct message'
}

function buildServerOptions(runtime) {
  const options = [
    {
      name: 'Direct Messages',
      description: `${runtime.conversations.length} conversation${runtime.conversations.length === 1 ? '' : 's'}`,
      value: DM_SERVER_KEY
    }
  ]

  for (const server of runtime.servers) {
    options.push({
      name: server.name,
      description: `${server.channels.filter((channel) => channel.type !== 'category').length} channels`,
      value: server.id
    })
  }

  if (options.length === 1) {
    options.push({
      name: 'No servers yet',
      description: 'Use /join <invite-code> after login',
      value: EMPTY_SERVER_KEY
    })
  }

  return options
}

function buildScopeOptions(runtime, selectedServerKey) {
  if (!runtime) {
    return []
  }

  if (!selectedServerKey || selectedServerKey === DM_SERVER_KEY) {
    const conversations = sortConversations(runtime.conversations)
    if (conversations.length === 0) {
      return [
        {
          name: 'No direct messages',
          description: 'Use /dm <username> to start one',
          value: null
        }
      ]
    }

    return conversations.map((conversation) => {
      const lastMessageAt = conversation.last_message?.inserted_at || conversation.inserted_at
      return {
        name: `@${formatConversationName(conversation, runtime.user?.id)}`,
        description: `Last activity ${timeLabel(lastMessageAt)}`,
        value: {
          kind: 'dm',
          id: conversation.id
        }
      }
    })
  }

  const server = runtime.getServer(selectedServerKey)
  if (!server) {
    return [
      {
        name: 'No channels',
        description: 'Join a server to populate this pane',
        value: null
      }
    ]
  }

  const channels = server.channels.filter((channel) => channel.type !== 'category')
  if (channels.length === 0) {
    return [
      {
        name: 'No channels',
        description: 'This server has no navigable channels yet',
        value: null
      }
    ]
  }

  return channels.map((channel) => ({
    name: `#${channel.name}`,
    description: channel.topic || `Last activity ${timeLabel(channel.last_message_inserted_at)}`,
    value: {
      kind: 'channel',
      id: channel.id,
      serverId: server.id
    }
  }))
}

class SecretInputRenderable extends TextRenderable {
  constructor(ctx, options = {}) {
    super(ctx, {
      width: '100%',
      height: 1,
      focusable: true,
      backgroundColor: options.backgroundColor || COLORS.panelAlt,
      fg: options.textColor || COLORS.text,
      wrapMode: 'none',
      truncate: true,
      content: ''
    })

    this.rawValue = options.value || ''
    this.placeholder = options.placeholder || ''
    this.backgroundColor = options.backgroundColor || COLORS.panelAlt
    this.focusedBackgroundColor = options.focusedBackgroundColor || '#163148'
    this.textColor = options.textColor || COLORS.text
    this.focusedTextColor = options.focusedTextColor || COLORS.text
    this.refreshDisplay()
  }

  focus() {
    super.focus()
    this.refreshDisplay()
  }

  blur() {
    super.blur()
    this.refreshDisplay()
  }

  get value() {
    return this.rawValue
  }

  set value(nextValue) {
    this.rawValue = String(nextValue || '')
    this.refreshDisplay()
  }

  set placeholder(nextValue) {
    this._placeholder = String(nextValue || '')
    this.refreshDisplay()
  }

  get placeholder() {
    return this._placeholder
  }

  handleKeyPress(key) {
    if (key.name === 'enter' || key.name === 'return') {
      this.emit(InputRenderableEvents.ENTER, this.rawValue)
      return true
    }

    if (key.name === 'backspace') {
      if (this.rawValue.length > 0) {
        this.rawValue = this.rawValue.slice(0, -1)
        this.emit(InputRenderableEvents.INPUT, this.rawValue)
        this.refreshDisplay()
      }
      return true
    }

    if (key.name === 'delete') {
      this.rawValue = ''
      this.emit(InputRenderableEvents.INPUT, this.rawValue)
      this.refreshDisplay()
      return true
    }

    if (key.ctrl && key.name === 'u') {
      this.rawValue = ''
      this.emit(InputRenderableEvents.INPUT, this.rawValue)
      this.refreshDisplay()
      return true
    }

    if (!key.ctrl && !key.meta && typeof key.sequence === 'string' && /^[ -~]$/.test(key.sequence)) {
      this.rawValue += key.sequence
      this.emit(InputRenderableEvents.INPUT, this.rawValue)
      this.refreshDisplay()
      return true
    }

    return false
  }

  refreshDisplay() {
    const maskedValue = this.rawValue.length > 0 ? '*'.repeat(this.rawValue.length) : ''
    const isFocused = this.focused

    this.bg = isFocused ? this.focusedBackgroundColor : this.backgroundColor
    this.fg =
      this.rawValue.length > 0
        ? isFocused
          ? this.focusedTextColor
          : this.textColor
        : COLORS.faint

    const cursor = isFocused ? '|' : ''
    this.content = maskedValue || `${this.placeholder}${cursor}`
    if (maskedValue) {
      this.content = `${maskedValue}${cursor}`
    }
  }
}

class OpenTuiChatClient {
  constructor() {
    this.renderer = null
    this.runtime = null
    this.runtimeUrl = null
    this.screen = 'auth'
    this.authMode = 'login'
    this.focusables = []
    this.focusIndex = 0
    this.selectedServerKey = DM_SERVER_KEY
    this.activeScope = null
    this.messages = []
    this.latestRecoveryMnemonic = null
    this.status = 'Set a server URL, then log in or register.'
    this.error = null
    this.fields = {
      serverUrl: normalizeServerUrl(
        process.env.VESPER_API_URL || loadPersistedServerUrl('opentui-chat') || ''
      ),
      username: process.env.VESPER_USERNAME || '',
      password: process.env.VESPER_PASSWORD || '',
      confirmPassword: '',
      recoveryKey: process.env.VESPER_RECOVERY_KEY || '',
      unlockPassword: process.env.VESPER_PASSWORD || '',
      newPassword: process.env.VESPER_NEW_PASSWORD || '',
      composer: ''
    }
    this.view = {
      root: null,
      footerText: null,
      authModeTabs: null,
      authServerInput: null,
      authServerGroup: null,
      authUsernameInput: null,
      authUsernameGroup: null,
      authPasswordInput: null,
      authPasswordGroup: null,
      authConfirmInput: null,
      authConfirmGroup: null,
      authRecoveryInput: null,
      authRecoveryGroup: null,
      authNewPasswordInput: null,
      authNewPasswordGroup: null,
      authFormText: null,
      authHeroText: null,
      mnemonicBody: null,
      approveInput: null,
      unlockInput: null,
      approveText: null,
      serverSelect: null,
      scopeSelect: null,
      chatHeader: null,
      transcript: null,
      composer: null,
      sidebarText: null,
      eventsText: null
    }

    this.boundKeypress = (key) => {
      void this.handleGlobalKeypress(key)
    }
  }

  async start() {
    this.renderer = await createCliRenderer({
      useAlternateScreen: true,
      autoFocus: true,
      useConsole: false,
      useMouse: true,
      enableMouseMovement: true,
      backgroundColor: COLORS.appBg,
      useKittyKeyboard: {
        disambiguate: true,
        alternateKeys: true
      }
    })

    this.renderer.keyInput.on('keypress', this.boundKeypress)
    this.mountAuthScreen()
    await this.tryResumeSession()
    this.renderer.start()
  }

  async stop() {
    if (this.runtime) {
      this.detachRuntime(this.runtime)
      this.runtime.shutdown()
      this.runtime = null
      this.runtimeUrl = null
    }

    if (this.renderer) {
      this.renderer.keyInput.off('keypress', this.boundKeypress)
      await this.renderer.destroy()
      this.renderer = null
    }
  }

  async handleGlobalKeypress(key) {
    if (!this.renderer) {
      return
    }

    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      await this.stop()
      process.exit(0)
      return
    }

    if (key.name === 'tab') {
      key.preventDefault()
      if (key.shift) {
        this.focusPrevious()
      } else {
        this.focusNext()
      }
      return
    }

    if (key.name === 'escape') {
      key.preventDefault()
      if (this.screen === 'chat' && this.view.composer) {
        this.setFocus(this.view.composer)
      } else if (this.screen === 'auth' && this.view.authModeTabs) {
        this.setFocus(this.view.authModeTabs)
      }
      return
    }

    if (this.screen === 'chat') {
      if (key.ctrl && key.name === 'r') {
        key.preventDefault()
        await this.refreshWorkspaceAndScope()
        return
      }

      if (key.ctrl && key.name === 'l' && this.view.serverSelect) {
        key.preventDefault()
        this.setFocus(this.view.serverSelect)
        return
      }

      if (key.ctrl && key.name === 'k' && this.view.scopeSelect) {
        key.preventDefault()
        this.setFocus(this.view.scopeSelect)
        return
      }

      if (key.ctrl && key.name === 'j' && this.view.composer) {
        key.preventDefault()
        this.setFocus(this.view.composer)
      }
    }

    if (this.screen === 'mnemonic' && (key.name === 'enter' || key.name === 'return')) {
      key.preventDefault()
      await this.handlePostAuth('Recovery key screen acknowledged.')
    }
  }

  setStatus(message, error = false) {
    this.status = message
    this.error = error ? message : null
    if (this.view.footerText) {
      this.view.footerText.content = this.buildFooterText()
      this.view.footerText.fg = error ? COLORS.danger : COLORS.muted
    }
  }

  buildFooterText() {
    const prefix = this.error ? `Error: ${this.status}` : this.status
    const hintsByScreen = {
      auth: 'Tab moves focus. Enter advances or submits.',
      mnemonic: 'Press Enter to continue into the chat client.',
      approve: 'Paste your recovery key, then press Enter.',
      chat: 'Tab cycles panes. Ctrl+L servers. Ctrl+K scopes. Ctrl+J composer. /help for commands.'
    }

    return `${prefix}\n${hintsByScreen[this.screen]}`
  }

  setFocusables(renderables) {
    this.focusables = renderables.filter(Boolean)
    this.focusIndex = 0
  }

  setFocus(renderable) {
    const index = this.focusables.indexOf(renderable)
    if (index >= 0) {
      this.focusIndex = index
    }

    if (renderable && typeof renderable.focus === 'function') {
      renderable.focus()
    }
  }

  focusNext() {
    if (this.focusables.length === 0) {
      return
    }

    this.focusIndex = (this.focusIndex + 1) % this.focusables.length
    this.setFocus(this.focusables[this.focusIndex])
  }

  focusPrevious() {
    if (this.focusables.length === 0) {
      return
    }

    this.focusIndex =
      (this.focusIndex - 1 + this.focusables.length) % this.focusables.length
    this.setFocus(this.focusables[this.focusIndex])
  }

  clearRoot() {
    if (!this.renderer) {
      return
    }

    const children = [...this.renderer.root.getChildren()]
    for (const child of children) {
      this.renderer.root.remove(child.id)
      child.destroyRecursively()
    }

    this.view = {
      root: null,
      footerText: null,
      authModeTabs: null,
      authServerInput: null,
      authServerGroup: null,
      authUsernameInput: null,
      authUsernameGroup: null,
      authPasswordInput: null,
      authPasswordGroup: null,
      authConfirmInput: null,
      authConfirmGroup: null,
      authRecoveryInput: null,
      authRecoveryGroup: null,
      authNewPasswordInput: null,
      authNewPasswordGroup: null,
      authFormText: null,
      authHeroText: null,
      mnemonicBody: null,
      approveInput: null,
      unlockInput: null,
      approveText: null,
      serverSelect: null,
      scopeSelect: null,
      chatHeader: null,
      transcript: null,
      composer: null,
      sidebarText: null,
      eventsText: null
    }
  }

  createShell() {
    const root = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: COLORS.appBg,
      padding: 1,
      rowGap: 1
    })

    const content = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      width: '100%',
      backgroundColor: COLORS.appBg
    })

    const footer = new BoxRenderable(this.renderer, {
      width: '100%',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1
    })

    const footerText = new TextRenderable(this.renderer, {
      content: this.buildFooterText(),
      fg: COLORS.muted,
      wrapMode: 'word'
    })

    footer.add(footerText)
    root.add(content)
    root.add(footer)
    this.renderer.root.add(root)

    this.view.root = content
    this.view.footerText = footerText

    return content
  }

  createLabeledInput(parent, label, key, placeholder, secret = false) {
    const group = new BoxRenderable(this.renderer, {
      width: '100%',
      flexDirection: 'column',
      rowGap: 0,
      backgroundColor: COLORS.panelBg
    })

    const labelText = new TextRenderable(this.renderer, {
      content: label,
      fg: COLORS.muted
    })

    const input = secret
      ? new SecretInputRenderable(this.renderer, {
          width: '100%',
          backgroundColor: COLORS.panelAlt,
          textColor: COLORS.accentWarm,
          focusedBackgroundColor: '#163148',
          focusedTextColor: COLORS.text,
          placeholder,
          value: this.fields[key]
        })
      : new InputRenderable(this.renderer, {
          width: '100%',
          backgroundColor: COLORS.panelAlt,
          textColor: COLORS.text,
          focusedBackgroundColor: '#163148',
          focusedTextColor: COLORS.text,
          placeholder,
          value: this.fields[key]
        })

    input.on(InputRenderableEvents.INPUT, (value) => {
      this.fields[key] = value
    })

    group.add(labelText)
    group.add(input)
    parent.add(group)

    return {
      group,
      input
    }
  }

  mountAuthScreen() {
    this.screen = 'auth'
    this.clearRoot()
    const content = this.createShell()

    const body = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'row',
      columnGap: 2,
      backgroundColor: COLORS.appBg
    })

    const hero = new BoxRenderable(this.renderer, {
      width: '43%',
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1
    })

    const form = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1
    })

    const logo = new ASCIIFontRenderable(this.renderer, {
      text: 'VESPER',
      font: 'tiny',
      color: [COLORS.accent, COLORS.accentWarm],
      backgroundColor: COLORS.panelBg
    })

    const heroText = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    const modeTabs = new TabSelectRenderable(this.renderer, {
      width: '100%',
      options: AUTH_MODES.map((mode) => ({
        name: mode.name,
        description: mode.description,
        value: mode.key
      })),
      selectedBackgroundColor: COLORS.accent,
      selectedTextColor: '#051018',
      selectedDescriptionColor: '#051018',
      backgroundColor: COLORS.panelAlt,
      textColor: COLORS.text,
      focusedBackgroundColor: '#163148',
      focusedTextColor: COLORS.text,
      showDescription: true,
      showUnderline: true,
      wrapSelection: true
    })

    modeTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
      if (option?.value) {
        this.authMode = option.value
        this.refreshAuthCopy()
      }
    })

    const formText = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    const inputs = new BoxRenderable(this.renderer, {
      width: '100%',
      flexDirection: 'column',
      rowGap: 1,
      backgroundColor: COLORS.panelBg
    })

    const serverField = this.createLabeledInput(
      inputs,
      'Server URL',
      'serverUrl',
      'http://127.0.0.1:4000'
    )
    const usernameField = this.createLabeledInput(
      inputs,
      'Username',
      'username',
      'alice'
    )
    const passwordField = this.createLabeledInput(
      inputs,
      'Password',
      'password',
      'your password',
      true
    )
    const confirmField = this.createLabeledInput(
      inputs,
      'Confirm password',
      'confirmPassword',
      'repeat your password',
      true
    )
    const recoveryField = this.createLabeledInput(
      inputs,
      'Recovery key',
      'recoveryKey',
      'word1 word2 word3 ...'
    )
    const newPasswordField = this.createLabeledInput(
      inputs,
      'New password',
      'newPassword',
      'new password',
      true
    )

    const wireSubmit = (input, handler) => {
      input.on(InputRenderableEvents.ENTER, () => {
        void handler()
      })
    }

    wireSubmit(serverField.input, async () => {
      if (this.authMode === 'recover') {
        this.setFocus(recoveryField.input)
        return
      }

      this.setFocus(usernameField.input)
    })
    wireSubmit(usernameField.input, async () => {
      this.setFocus(passwordField.input)
    })
    wireSubmit(passwordField.input, async () => {
      if (this.authMode === 'login') {
        await this.submitAuth()
        return
      }

      this.setFocus(confirmField.input)
    })
    wireSubmit(confirmField.input, async () => {
      await this.submitAuth()
    })
    wireSubmit(recoveryField.input, async () => {
      if (this.authMode === 'recover') {
        this.setFocus(newPasswordField.input)
      }
    })
    wireSubmit(newPasswordField.input, async () => {
      await this.submitAuth()
    })

    const formHelp = new TextRenderable(this.renderer, {
      content:
        'This sample acts like a real SDK consumer: it asks for a server URL, signs in, waits for device trust, then drops into chat.',
      fg: COLORS.faint,
      wrapMode: 'word'
    })

    hero.add(logo)
    hero.add(heroText)
    form.add(modeTabs)
    form.add(formText)
    form.add(inputs)
    form.add(formHelp)
    body.add(hero)
    body.add(form)
    content.add(body)

    this.view.authModeTabs = modeTabs
    this.view.authServerInput = serverField.input
    this.view.authServerGroup = serverField.group
    this.view.authUsernameInput = usernameField.input
    this.view.authUsernameGroup = usernameField.group
    this.view.authPasswordInput = passwordField.input
    this.view.authPasswordGroup = passwordField.group
    this.view.authConfirmInput = confirmField.input
    this.view.authConfirmGroup = confirmField.group
    this.view.authRecoveryInput = recoveryField.input
    this.view.authRecoveryGroup = recoveryField.group
    this.view.authNewPasswordInput = newPasswordField.input
    this.view.authNewPasswordGroup = newPasswordField.group
    this.view.authFormText = formText
    this.view.authHeroText = heroText

    const initialModeIndex = AUTH_MODES.findIndex((mode) => mode.key === this.authMode)
    modeTabs.setSelectedIndex(initialModeIndex >= 0 ? initialModeIndex : 0)

    this.refreshAuthCopy()
    this.setFocus(modeTabs)
  }

  refreshAuthCopy() {
    if (!this.view.authHeroText || !this.view.authFormText) {
      return
    }

    this.view.authConfirmGroup.visible = this.authMode === 'register'
    this.view.authRecoveryGroup.visible = this.authMode === 'recover'
    this.view.authNewPasswordGroup.visible = this.authMode === 'recover'
    this.view.authUsernameGroup.visible = this.authMode !== 'recover'
    this.view.authPasswordGroup.visible = this.authMode !== 'recover'

    const copyByMode = {
      login: {
        form: 'Sign into an existing account. If this terminal is a new device, Vesper will stop at the approval screen before encrypted chat unlocks.',
        hero: [
          'Terminal chat, not a dashboard.',
          '',
          'After login you get:',
          '- servers, channels, and DMs in the left panes',
          '- encrypted message history through the SDK',
          '- live socket updates without Playwright in the loop'
        ].join('\n')
      },
      register: {
        form: 'Create a new account on the chosen server. Registration returns a recovery key, then this sample moves into the full chat client.',
        hero: [
          'Fresh account flow.',
          '',
          'This sample keeps the important parts visible:',
          '- the server URL belongs to the app consumer',
          '- the recovery key is shown once after signup',
          '- the rest of the experience stays in the terminal'
        ].join('\n')
      },
      recover: {
        form: 'Paste your recovery key and pick a new password. If recovery succeeds, the same device can continue into servers, DMs, and channels.',
        hero: [
          'Recovery stays in-band.',
          '',
          'Use this when:',
          '- you lost your old device',
          '- you need to rebind the account here',
          '- you still want the sample to behave like a real client'
        ].join('\n')
      }
    }

    const copy = copyByMode[this.authMode]
    this.view.authFormText.content = copy.form
    this.view.authHeroText.content = copy.hero
    this.view.authHeroText.fg = COLORS.text
    this.setFocusables(
      this.authMode === 'recover'
        ? [
            this.view.authModeTabs,
            this.view.authServerInput,
            this.view.authRecoveryInput,
            this.view.authNewPasswordInput
          ]
        : this.authMode === 'register'
          ? [
              this.view.authModeTabs,
              this.view.authServerInput,
              this.view.authUsernameInput,
              this.view.authPasswordInput,
              this.view.authConfirmInput
            ]
          : [
              this.view.authModeTabs,
              this.view.authServerInput,
              this.view.authUsernameInput,
              this.view.authPasswordInput
            ]
    )
    this.setStatus(`Ready to ${this.authMode}.`)
  }

  mountMnemonicScreen() {
    this.screen = 'mnemonic'
    this.clearRoot()
    const content = this.createShell()

    const panel = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1
    })

    const title = new ASCIIFontRenderable(this.renderer, {
      text: 'RECOVER',
      font: 'tiny',
      color: [COLORS.accentWarm, COLORS.accent],
      backgroundColor: COLORS.panelBg
    })

    const body = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    panel.add(title)
    panel.add(body)
    content.add(panel)

    this.view.mnemonicBody = body
    this.refreshMnemonicScreen()
    this.setFocusables([])
    this.setStatus('Registration finished. Save your recovery key, then press Enter.')
  }

  refreshMnemonicScreen() {
    if (!this.view.mnemonicBody) {
      return
    }

    this.view.mnemonicBody.content = [
      'Account created.',
      '',
      'Recovery key:',
      this.latestRecoveryMnemonic || 'No recovery key returned.',
      '',
      'Press Enter to continue into the chat client.'
    ].join('\n')
  }

  mountApproveScreen() {
    this.screen = 'approve'
    this.clearRoot()
    const content = this.createShell()

    const body = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'row',
      columnGap: 2,
      backgroundColor: COLORS.appBg
    })

    const form = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1
    })

    const devices = new BoxRenderable(this.renderer, {
      width: '34%',
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1
    })

    const formText = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    form.add(formText)

    const recoveryField = this.createLabeledInput(
      form,
      'Recovery key',
      'recoveryKey',
      'word1 word2 word3 ...'
    )
    recoveryField.input.on(InputRenderableEvents.ENTER, () => {
      void this.submitApproval()
    })

    const unlockField = this.createLabeledInput(
      form,
      'Account password',
      'unlockPassword',
      'your password',
      true
    )
    unlockField.input.on(InputRenderableEvents.ENTER, () => {
      void this.submitUnlock()
    })

    const deviceText = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    devices.add(deviceText)
    body.add(form)
    body.add(devices)
    content.add(body)

    this.view.approveInput = recoveryField.input
    this.view.unlockInput = unlockField.input
    this.view.approveText = formText
    this.view.sidebarText = deviceText
    this.setFocusables([recoveryField.input, unlockField.input])
    this.refreshApproveScreen()
  }

  refreshApproveScreen() {
    if (
      !this.runtime ||
      !this.view.approveText ||
      !this.view.sidebarText ||
      !this.view.approveInput ||
      !this.view.unlockInput
    ) {
      return
    }

    const currentDevice = this.runtime.currentDevice
    const pendingDevices = this.runtime.devices.filter((device) => device.trust_state === 'pending')
    const needsUnlock =
      currentDevice?.trust_state === 'trusted' &&
      !this.runtime.canUseE2EE

    this.view.approveInput.visible = !needsUnlock
    this.view.unlockInput.visible = needsUnlock

    this.view.approveText.content = needsUnlock
      ? [
          'This device is now trusted, but encrypted chat is still locked locally.',
          '',
          'Enter your account password to hydrate the encrypted identity on this machine and continue into chat.',
          '',
          `Current device: ${currentDevice?.name || 'unknown'} (${currentDevice?.trust_state || 'unknown'})`
        ].join('\n')
      : [
          'This device is not fully trusted yet.',
          '',
          'Paste your recovery key here if this is your only device, or approve it from another trusted Vesper client. When approval arrives, this screen will switch to the next step automatically.',
          '',
          `Current device: ${currentDevice?.name || 'unknown'} (${currentDevice?.trust_state || 'unknown'})`
        ].join('\n')

    this.view.sidebarText.content = [
      'Devices',
      '',
      ...this.runtime.devices.map((device) => {
        const marker = device.id === currentDevice?.id ? '*' : '-'
        return `${marker} ${device.name}\n  ${device.platform || 'unknown'} | ${device.trust_state}`
      }),
      '',
      `Pending count: ${pendingDevices.length}`
    ].join('\n')

    this.setFocus(
      needsUnlock
        ? this.view.unlockInput
        : this.view.approveInput
    )

    this.setStatus(
      needsUnlock
        ? 'Device approved. Enter your password to unlock encrypted chat on this machine.'
        : 'Device approval is required before encrypted chat is available.'
    )
  }

  mountChatScreen() {
    this.screen = 'chat'
    this.clearRoot()
    const content = this.createShell()

    const body = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'row',
      columnGap: 1,
      backgroundColor: COLORS.appBg
    })

    const serversPane = new BoxRenderable(this.renderer, {
      width: 24,
      height: '100%',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      title: 'Servers'
    })

    const scopesPane = new BoxRenderable(this.renderer, {
      width: 34,
      height: '100%',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      title: 'Channels'
    })

    const chatPane = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1,
      title: 'Chat'
    })

    const sidePane = new BoxRenderable(this.renderer, {
      width: 34,
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panelBg,
      padding: 1,
      rowGap: 1,
      title: 'Session'
    })

    const serverSelect = new SelectRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      backgroundColor: COLORS.panelBg,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.panelAlt,
      focusedTextColor: COLORS.text,
      selectedBackgroundColor: COLORS.accent,
      selectedTextColor: '#051018',
      descriptionColor: COLORS.faint,
      selectedDescriptionColor: '#051018',
      showDescription: true,
      wrapSelection: true
    })

    const scopeSelect = new SelectRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      backgroundColor: COLORS.panelBg,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.panelAlt,
      focusedTextColor: COLORS.text,
      selectedBackgroundColor: COLORS.accentWarm,
      selectedTextColor: '#051018',
      descriptionColor: COLORS.faint,
      selectedDescriptionColor: '#051018',
      showDescription: true,
      wrapSelection: true
    })

    serverSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
      this.selectedServerKey = option?.value || DM_SERVER_KEY
      this.refreshScopeOptions()
    })

    scopeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
      if (option?.value) {
        void this.selectScope(option.value)
      }
    })

    const chatHeader = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    const transcript = new TextRenderable(this.renderer, {
      content: '',
      flexGrow: 1,
      fg: COLORS.text,
      wrapMode: 'word',
      backgroundColor: COLORS.panelAlt
    })

    const composer = new InputRenderable(this.renderer, {
      width: '100%',
      backgroundColor: COLORS.panelAlt,
      textColor: COLORS.text,
      focusedBackgroundColor: '#163148',
      focusedTextColor: COLORS.text,
      placeholder: 'Type a message or /help'
    })

    composer.on(InputRenderableEvents.INPUT, (value) => {
      this.fields.composer = value
    })
    composer.on(InputRenderableEvents.ENTER, () => {
      void this.submitComposer()
    })

    const sidebarText = new TextRenderable(this.renderer, {
      content: '',
      fg: COLORS.text,
      wrapMode: 'word'
    })

    const eventsText = new TextRenderable(this.renderer, {
      content: '',
      flexGrow: 1,
      fg: COLORS.muted,
      wrapMode: 'word',
      backgroundColor: COLORS.panelAlt
    })

    serversPane.add(serverSelect)
    scopesPane.add(scopeSelect)
    chatPane.add(chatHeader)
    chatPane.add(transcript)
    chatPane.add(composer)
    sidePane.add(sidebarText)
    sidePane.add(eventsText)
    body.add(serversPane)
    body.add(scopesPane)
    body.add(chatPane)
    body.add(sidePane)
    content.add(body)

    this.view.serverSelect = serverSelect
    this.view.scopeSelect = scopeSelect
    this.view.chatHeader = chatHeader
    this.view.transcript = transcript
    this.view.composer = composer
    this.view.sidebarText = sidebarText
    this.view.eventsText = eventsText

    this.setFocusables([serverSelect, scopeSelect, composer])
    this.refreshChatChrome()
    this.setFocus(composer)
  }

  refreshChatChrome() {
    if (!this.runtime || !this.view.serverSelect || !this.view.scopeSelect) {
      return
    }

    const serverOptions = buildServerOptions(this.runtime)
    this.view.serverSelect.options = serverOptions

    const existingServerIndex = serverOptions.findIndex(
      (option) => option.value === this.selectedServerKey
    )
    if (existingServerIndex >= 0) {
      this.view.serverSelect.setSelectedIndex(existingServerIndex)
    } else {
      this.selectedServerKey =
        serverOptions[0]?.value === EMPTY_SERVER_KEY ? DM_SERVER_KEY : serverOptions[0]?.value
      this.view.serverSelect.setSelectedIndex(0)
    }

    this.refreshScopeOptions()
    this.refreshSessionSidebar()
    this.refreshEventsPanel()
  }

  refreshScopeOptions() {
    if (!this.runtime || !this.view.scopeSelect) {
      return
    }

    const options = buildScopeOptions(this.runtime, this.selectedServerKey)
    this.view.scopeSelect.options = options

    if (!this.activeScope) {
      const firstScope = options.find((option) => option.value)
      if (firstScope?.value) {
        this.view.scopeSelect.setSelectedIndex(options.indexOf(firstScope))
        void this.selectScope(firstScope.value)
      } else {
        this.messages = []
        this.refreshTranscript()
      }
      return
    }

    const activeIndex = options.findIndex(
      (option) =>
        option.value?.kind === this.activeScope?.kind &&
        option.value?.id === this.activeScope?.id
    )

    if (activeIndex >= 0) {
      this.view.scopeSelect.setSelectedIndex(activeIndex)
      return
    }

    const firstScope = options.find((option) => option.value)
    if (firstScope?.value) {
      this.view.scopeSelect.setSelectedIndex(options.indexOf(firstScope))
      void this.selectScope(firstScope.value)
    } else {
      this.activeScope = null
      this.messages = []
      this.refreshTranscript()
    }
  }

  refreshTranscript() {
    if (!this.view.chatHeader || !this.view.transcript || !this.runtime) {
      return
    }

    const headerLines = [
      formatScopeLabel(this.runtime, this.activeScope),
      `User: ${this.runtime.user?.username || 'unknown'} | Device: ${this.runtime.currentDevice?.trust_state || 'unknown'}`
    ]

    this.view.chatHeader.content = headerLines.join('\n')

    if (!this.activeScope) {
      this.view.transcript.content = 'Select a server, channel, or DM to start chatting.'
      return
    }

    if (this.messages.length === 0) {
      this.view.transcript.content = 'No messages yet.'
      return
    }

    this.view.transcript.content = this.messages
      .map((message) => formatMessageLine(message, this.runtime.user?.id))
      .join('\n\n')
    this.view.transcript.scrollY = this.view.transcript.maxScrollY
  }

  refreshSessionSidebar() {
    if (!this.runtime || !this.view.sidebarText) {
      return
    }

    const pendingDevices = this.runtime.devices.filter((device) => device.trust_state === 'pending')
    this.view.sidebarText.content = [
      `Server URL`,
      normalizeServerUrl(this.runtimeUrl || ''),
      '',
      `Current user`,
      `${this.runtime.user?.username || 'unknown'} (${this.runtime.user?.id || 'n/a'})`,
      '',
      `Current device`,
      `${this.runtime.currentDevice?.name || 'unknown'}`,
      `${this.runtime.currentDevice?.platform || 'unknown'} | ${this.runtime.currentDevice?.trust_state || 'unknown'}`,
      '',
      `Workspace`,
      `${this.runtime.servers.length} servers`,
      `${this.runtime.conversations.length} direct messages`,
      `${pendingDevices.length} pending devices`,
      '',
      `Slash commands`,
      '/help',
      '/refresh',
      '/dm <username>',
      '/join <invite-code>',
      '/logout',
      '/quit'
    ].join('\n')
  }

  refreshEventsPanel() {
    if (!this.view.eventsText || !this.runtime) {
      return
    }

    const events = this.runtime.transcriptEvents.slice(0, 12)
    if (events.length === 0) {
      this.view.eventsText.content = 'Live socket events show up here.'
      return
    }

    this.view.eventsText.content = events
      .map((event) => `[${event.at}] ${event.name}\n${event.summary}`)
      .join('\n\n')
  }

  attachRuntime(runtime) {
    runtime.on('workspace', () => {
      if (this.screen === 'approve') {
        this.refreshApproveScreen()
      }

      if (this.screen === 'chat') {
        this.refreshChatChrome()
      }

      if (this.screen === 'approve' && this.canEnterChat()) {
        this.mountChatScreen()
      }
    })

    runtime.on('messages', ({ scopeId, messages }) => {
      if (this.activeScope?.id === scopeId) {
        this.messages = messages
        this.refreshTranscript()
      }
    })

    runtime.on('events', () => {
      if (this.screen === 'chat') {
        this.refreshEventsPanel()
      }
    })

    runtime.on('user-event', ({ event }) => {
      if (event === 'device_updated' || event === 'device_approval_requested') {
        if (this.screen === 'approve') {
          this.refreshApproveScreen()
        }
        this.setStatus('Device state changed. Refreshing workspace.')
      }
    })
  }

  detachRuntime(runtime) {
    runtime.removeAllListeners('workspace')
    runtime.removeAllListeners('messages')
    runtime.removeAllListeners('events')
    runtime.removeAllListeners('user-event')
  }

  async ensureRuntime() {
    const nextUrl = normalizeServerUrl(this.fields.serverUrl)
    if (!nextUrl) {
      throw new Error('Enter a server URL first.')
    }

    if (this.runtime && this.runtimeUrl === nextUrl) {
      return this.runtime
    }

    if (this.runtime) {
      this.detachRuntime(this.runtime)
      this.runtime.shutdown()
      this.runtime = null
    }

    process.env.VESPER_API_URL = nextUrl
    this.runtime = new VesperChatRuntime({
      deviceLabel: 'opentui-chat',
      deviceName: 'SDK Sample OpenTUI Chat'
    })
    this.runtimeUrl = nextUrl
    this.attachRuntime(this.runtime)
    this.selectedServerKey = DM_SERVER_KEY
    this.activeScope = null
    this.messages = []

    return this.runtime
  }

  async tryResumeSession() {
    if (!this.fields.serverUrl) {
      return
    }

    try {
      this.setStatus('Checking saved session...')
      const runtime = await this.ensureRuntime()
      const restored = await runtime.restoreSession()
      if (!restored) {
        this.setStatus('No saved session. Log in or register.')
        return
      }

      await this.handlePostAuth('Resumed saved session.')
    } catch {
      this.setStatus('Saved session could not be resumed. Log in again.')
    }
  }

  canEnterChat() {
    if (!this.runtime || !this.runtime.currentDevice) {
      return false
    }

    return (
      this.runtime.currentDevice.trust_state === 'trusted' &&
      this.runtime.canUseE2EE
    )
  }

  async submitAuth() {
    try {
      const runtime = await this.ensureRuntime()
      this.error = null

      if (this.authMode === 'login') {
        if (!this.fields.username || !this.fields.password) {
          throw new Error('Username and password are required.')
        }

        await runtime.login(this.fields.username, this.fields.password)
        this.latestRecoveryMnemonic = null
        await this.handlePostAuth('Logged in.')
        return
      }

      if (this.authMode === 'register') {
        if (!this.fields.username || !this.fields.password) {
          throw new Error('Username and password are required.')
        }
        if (this.fields.password !== this.fields.confirmPassword) {
          throw new Error('Passwords do not match.')
        }

        const session = await runtime.register(this.fields.username, this.fields.password)
        this.latestRecoveryMnemonic = session.recoveryMnemonic || null
        this.fields.confirmPassword = ''
        this.mountMnemonicScreen()
        return
      }

      if (!this.fields.recoveryKey || !this.fields.newPassword) {
        throw new Error('Recovery key and new password are required.')
      }

      await runtime.recoverAccount(this.fields.recoveryKey, this.fields.newPassword)
      this.latestRecoveryMnemonic = null
      this.fields.newPassword = ''
      await this.handlePostAuth('Recovery finished.')
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Auth failed.', true)
    }
  }

  async handlePostAuth(status) {
    if (!this.runtime) {
      return
    }

    if (this.canEnterChat()) {
      this.mountChatScreen()
      this.setStatus(status)
      return
    }

    this.mountApproveScreen()
    this.setStatus(`${status} This device still needs approval.`)
  }

  async submitApproval() {
    if (!this.runtime) {
      return
    }

    try {
      if (!this.fields.recoveryKey.trim()) {
        throw new Error('Paste the recovery key for this device first.')
      }

      await this.runtime.approveCurrentDeviceWithRecovery(this.fields.recoveryKey)
      if (this.canEnterChat()) {
        this.mountChatScreen()
        this.setStatus('Device approved. Chat is ready.')
        return
      }

      this.refreshApproveScreen()
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : 'Device approval failed.',
        true
      )
    }
  }

  async submitUnlock() {
    if (!this.runtime) {
      return
    }

    try {
      if (!this.fields.unlockPassword.trim()) {
        throw new Error('Enter your password to unlock this trusted device.')
      }

      await this.runtime.unlockTrustedDevice(this.fields.unlockPassword)
      this.fields.unlockPassword = ''

      if (this.view.unlockInput) {
        this.view.unlockInput.value = ''
      }

      if (this.canEnterChat()) {
        this.mountChatScreen()
        this.setStatus('Encrypted chat unlocked.')
        return
      }

      this.refreshApproveScreen()
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : 'Device unlock failed.',
        true
      )
    }
  }

  async refreshWorkspaceAndScope() {
    if (!this.runtime) {
      return
    }

    await this.runtime.refreshWorkspace()
    if (this.activeScope) {
      await this.runtime.fetchScopeMessages(this.activeScope).catch(() => {})
    }

    if (this.screen === 'chat') {
      this.refreshChatChrome()
    }
  }

  async selectScope(scope) {
    if (!this.runtime || !scope) {
      return
    }

    this.activeScope = {
      kind: scope.kind,
      id: scope.id
    }
    this.messages = this.runtime.scopeMessages.get(scope.id) || []
    this.refreshTranscript()

    try {
      await this.runtime.openScope(this.activeScope)
      this.messages = this.runtime.scopeMessages.get(scope.id) || []
      this.refreshTranscript()
      this.setStatus(`Opened ${formatScopeLabel(this.runtime, this.activeScope)}.`)
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : 'Could not open that chat.',
        true
      )
    }
  }

  async submitComposer() {
    if (!this.runtime || !this.activeScope) {
      return
    }

    const input = this.fields.composer.trim()
    if (!input) {
      return
    }

    try {
      if (input.startsWith('/')) {
        await this.runSlashCommand(input)
      } else {
        await this.runtime.sendToScope(this.activeScope, input)
        this.setStatus(`Sent to ${formatScopeLabel(this.runtime, this.activeScope)}.`)
      }

      this.fields.composer = ''
      if (this.view.composer) {
        this.view.composer.value = ''
      }
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : 'Message send failed.',
        true
      )
    }
  }

  async runSlashCommand(rawInput) {
    const [command, ...args] = rawInput.slice(1).trim().split(/\s+/)
    const name = (command || '').toLowerCase()

    if (!name || name === 'help') {
      this.setStatus('Commands: /help /refresh /dm <username> /join <invite-code> /logout /quit')
      return
    }

    if (name === 'refresh') {
      await this.refreshWorkspaceAndScope()
      this.setStatus('Workspace refreshed.')
      return
    }

    if (name === 'dm') {
      const username = args[0]
      if (!username) {
        throw new Error('Usage: /dm <username>')
      }

      const beforeIds = new Set(this.runtime.conversations.map((conversation) => conversation.id))
      await this.runtime.createDirectMessage(username)
      this.selectedServerKey = DM_SERVER_KEY
      this.refreshChatChrome()

      const targetConversation =
        sortConversations(this.runtime.conversations).find(
          (conversation) => !beforeIds.has(conversation.id)
        ) ||
        this.runtime.conversations.find((conversation) =>
          conversation.participants.some(
            (participant) =>
              participant.user_id !== this.runtime.user?.id &&
              participant.user.username === username
          )
        )

      if (targetConversation) {
        await this.selectScope({
          kind: 'dm',
          id: targetConversation.id
        })
      }

      this.setStatus(`Direct message ready for ${username}.`)
      return
    }

    if (name === 'join') {
      const inviteCode = args[0]
      if (!inviteCode) {
        throw new Error('Usage: /join <invite-code>')
      }

      const beforeIds = new Set(this.runtime.servers.map((server) => server.id))
      await this.runtime.joinServerByInvite(inviteCode)
      this.refreshChatChrome()

      const joinedServer =
        this.runtime.servers.find((server) => !beforeIds.has(server.id)) ||
        this.runtime.servers[this.runtime.servers.length - 1]

      if (joinedServer) {
        this.selectedServerKey = joinedServer.id
        this.refreshChatChrome()
      }

      this.setStatus(`Joined server with invite ${inviteCode}.`)
      return
    }

    if (name === 'logout') {
      await this.runtime.logout()
      this.detachRuntime(this.runtime)
      this.runtime.shutdown()
      this.runtime = null
      this.runtimeUrl = null
      this.activeScope = null
      this.messages = []
      this.mountAuthScreen()
      this.setStatus('Logged out.')
      return
    }

    if (name === 'quit' || name === 'exit') {
      await this.stop()
      process.exit(0)
      return
    }

    throw new Error(`Unknown command: /${name}`)
  }
}

async function main() {
  const app = new OpenTuiChatClient()

  const shutdown = async () => {
    await app.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  await app.start()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
