/**
 * Shared i18n dictionary type (EN/RU share the exact shape).
 * Cookie-only approach: flat URLs (/login, /projects, …) stay untouched,
 * no `[locale]` segment, no middleware rewrite. Default locale `en`.
 */
export type Dictionary = {
  metadata: {
    title: string;
    description: string;
  };
  nav: {
    projects: string;
    organizations: string;
    users: string;
    secrets: string;
    profile: string;
    aiProviders: string;
    chat: string;
    registries: string;
    databases: string;
    brokers: string;
    s3: string;
    dataPersist: string;
    volumes: string;
    console: string;
    sections: string;
  };
  common: {
    loading: string;
    loadingPage: string;
    refresh: string;
    retry: string;
    tryAgain: string;
    cancel: string;
    reveal: string;
    hide: string;
    copy: string;
    copied: string;
    delete: string;
    confirmDelete: string;
  };
  auth: {
    welcomeBack: string;
    subtitle: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    signIn: string;
    signingIn: string;
    signUp: string;
    signingUp: string;
    createAccount: string;
    haveAccount: string;
    noAccount: string;
    registerFailed: string;
    loginFailed: string;
    signedInMock: string;
    redirecting: string;
    mockHint: string;
  };
  validation: {
    invalidEmail: string;
    passwordMin: string;
    nameRequired: string;
    invalidCredentials: string;
    emailTaken: string;
    tooLong: string;
    invalidEmailDetailed: string;
  };
  errors: {
    somethingWentWrong: string;
    pageFailed: string;
    unexpected: string;
    updateFailed: string;
    sessionExpired: string;
    diagnosticId: string;
  };
  projects: {
    titleA: string;
    titleB: string;
    subtitle: string;
    emptyTitle: string;
    emptyDesc: string;
    updatedPrefix: string;
    detailSubtitle: string;
    notFoundTitle: string;
    notFoundDesc: string;
    back: string;
    brokenBadge: string;
    brokenTitle: string;
    brokenDesc: string;
    brokenReasonLabel: string;
    nested: {
      movedTitle: string;
      movedDesc: string;
      goneTitle: string;
      goneDesc: string;
      exitToOrg: string;
      effectiveTitle: string;
      effectiveEmpty: string;
    };
    tabs: {
      overview: string;
      secrets: string;
      ai: string;
      sessions: string;
      running: string;
    };
    overviewTitle: string;
    overviewDesc: string;
    secretsTitle: string;
    secretsDesc: string;
    aiTitle: string;
    aiDesc: string;
    createTrigger: string;
    create: {
      title: string;
      description: string;
      nameLabel: string;
      namePlaceholder: string;
      hint: string;
      submit: string;
      creating: string;
      validation: {
        required: string;
        tooShort: string;
        tooLong: string;
        invalidChars: string;
      };
    };
  };
  secrets: {
    titleA: string;
    titleB: string;
    subtitle: string;
    searchLabel: string;
    searchPlaceholder: string;
    emptyTitle: string;
    emptyDesc: string;
    noMatchesTitle: string;
    noMatchesDesc: (query: string) => string;
    revealedTitle: string;
    revealedDesc: string;
    deleteTitle: (name: string) => string;
    deleteDesc: string;
    notFound: (id: string) => string;
  };
  profile: {
    titleA: string;
    titleB: string;
    subtitle: string;
    savedTitle: string;
    savedDesc: string;
    overviewTitle: string;
    overviewDesc: string;
    editTitle: string;
    editDesc: string;
    nameLabel: string;
    emailLabel: string;
    emailReadOnlyHint: string;
    namePlaceholder: string;
    saveChanges: string;
    saving: string;
    reset: string;
    sincePrefix: string;
  };
  limits: {
    title: string;
    desc: string;
    rolling: string;
    daily: string;
    weekly: string;
    monthly: string;
    empty: string;
    hint: string;
    invalidTitle: string;
    invalidDesc: string;
    addKey: string;
    dialogTitle: string;
    dialogDesc: string;
    keyLabel: string;
    keyPlaceholder: string;
    keyHint: string;
    save: string;
    saving: string;
    required: string;
    tooShort: string;
  };
  aiProviders: {
    titleA: string;
    titleB: string;
    subtitle: string;
    doneTitle: string;
    emptyTitle: string;
    emptyDesc: string;
    connectedNotice: (name: string) => string;
    models: string;
    enableLabel: (name: string) => string;
    enabled: string;
    disabled: string;
    configure: string;
  };
  registries: {
    titleA: string;
    titleB: string;
    subtitle: string;
    searchLabel: string;
    searchPlaceholder: string;
    dockerImages: string;
    emptyTitle: string;
    emptyDesc: string;
    noMatchesTitle: string;
    noMatchesDesc: (query: string) => string;
    repositories: string;
    catalogEmpty: string;
  };
  npm: {
    titleA: string;
    titleB: string;
    subtitle: string;
    searchLabel: string;
    searchPlaceholder: string;
    packages: string;
    emptyTitle: string;
    emptyDesc: string;
    noMatchesTitle: string;
    noMatchesDesc: (query: string) => string;
    scopeLabel: string;
  };
  registry: {
    titleA: string;
    titleB: string;
    subtitle: string;
    dockerTitle: string;
    dockerDesc: string;
    npmTitle: string;
    npmDesc: string;
  };
  sessions: {
    streamTitle: string;
    streamSubtitle: string;
    connecting: string;
    live: string;
    reconnecting: string;
    error: string;
    eventsEmpty: string;
    reconnect: string;
    sessionsTitle: string;
    sessionsDesc: string;
    runningTitle: string;
    runningDesc: string;
    create: string;
    /** Sidebar panel heading above the chat list (session routes). */
    chatsTitle: string;
    /** Content-block hint: the list lives in the sidebar. */
    pickTitle: string;
    pickDesc: string;
    open: string;
    abort: string;
    untitled: string;
    /** Accessible name of the clickable session row (visible name = title). */
    openSession: (title: string) => string;
    /** Relative-time buckets of the session row meta line (mobile parity). */
    time: {
      justNow: string;
      minutesAgo: (count: number) => string;
      hoursAgo: (count: number) => string;
      daysAgo: (count: number) => string;
    };
    stop: string;
    emptyAll: string;
    emptyRunning: string;
  };
  chat: {
    title: string;
    subtitle: string;
    placeholder: string;
    send: string;
    stop: string;
    emptyTitle: string;
    emptyDesc: string;
    retry: string;
    /** Accessible name of the per-message retry button (user prompt resend). */
    retryMessage: string;
    streaming: string;
    you: string;
    assistant: string;
    sessionTitle: string;
    sessionSubtitle: string;
    modelLabel: string;
    modelProvider: string;
    modelIdPlaceholder: string;
    modelDefault: string;
    modelClear: string;
    modelActive: string;
    modeLabel: string;
    modeDefault: string;
    /** @deprecated Use modeLabel — kept for selector compat (пачка B). */
    agentLabel: string;
    /** @deprecated Use modeDefault — kept for selector compat (пачка B). */
    agentDefault: string;
    /** Jump-to-latest action of the kit MessageScroller. */
    scrollToEnd: string;
    /** Rotating "mode is working" phrases while sending (live turn open). */
    thinking: string[];
    /** Accessible name of the assistant-message like toggle. */
    like: string;
    /** Accessible name of the assistant-message dislike toggle. */
    dislike: string;
    /** Collapsible caption of the chronological tool-call timeline. */
    toolsTitle: string;
    /** Timeline caption when no tool call was recorded yet. */
    toolsEmpty: string;
    /** Collapsed debug block with the raw technical trace (never user-facing). */
    toolsDetails: string;
    /** Human label of a reasoning step (mode thinking, never a raw URL). */
    reasoningLabel: string;
    /** Tool lifecycle statuses (human words for the timeline, via t.chat). */
    toolCalled: string;
    toolProgress: string;
    toolDone: string;
    toolFailed: string;
    /** Reasoning phase fallbacks (human words, via t.chat). */
    reasoningStarted: string;
    reasoningThinking: string;
    reasoningDone: string;
    /** Label of the mode currently owning the in-flight turn. */
    activeMode: string;
    /** Label of the tool currently reported by the live part frames. */
    activeTool: string;
    /** Idle status hint (nothing running). */
    idle: string;
    /** Busy status hint while a turn runs. */
    busy: string;
    /** Fork action label. */
    fork: string;
    forkTitle: string;
    forkDesc: string;
    forkBefore: string;
    forkWhole: string;
    forkSuccess: string;
    forkEmpty: string;
    /** Revert action label. */
    revert: string;
    /** Accessible name of the messages-revert button (soft-delete tail). */
    revertMessages: string;
    revertTitle: string;
    revertDesc: string;
    revertStage: string;
    revertEmpty: string;
    revertCommit: string;
    revertDiscard: string;
    revertSuccess: string;
    revertCleared: string;
    dialogClose: string;
    /** Approval gate of a parked long-session turn (banner title). */
    approvalTitle: string;
    /** Approval gate continue action (approve resumes the same thread). */
    approvalContinue: string;
  };
  language: {
    label: string;
    en: string;
    ru: string;
    switchToEn: string;
    switchToRu: string;
  };
  userMenu: {
    profile: string;
    signOut: string;
    login: string;
    noEmail: string;
  };
  orgs: {
    titleA: string;
    titleB: string;
    subtitle: string;
    emptyTitle: string;
    emptyDesc: string;
    createTrigger: string;
    back: string;
    noMembership: string;
    detailSubtitle: string;
    notFoundTitle: string;
    notFoundDesc: string;
    overviewTitle: string;
    overviewDesc: string;
    membersTitle: string;
    membersDesc: string;
    changeRole: string;
    removeMember: string;
    roles: {
      maintainer: string;
      user: string;
    };
    inviteTitle: string;
    inviteDesc: string;
    inviteEmailPlaceholder: string;
    mintInvite: string;
    minting: string;
    copyLink: string;
    inviteAccepted: string;
    inviteAcceptedDesc: string;
    /** @deprecated Links never expire — kept one release for callers. */
    inviteExpired: string;
    /** @deprecated Links never expire — kept one release for callers. */
    inviteExpiredDesc: string;
    inviteReplay: string;
    inviteReplayDesc: string;
    forbidden: string;
    forbiddenDesc: string;
    projectsTitle: string;
    projectsDesc: string;
    linkProject: string;
    unlinkProject: string;
    linkPlaceholder: string;
    lastMaintainer: string;
    alreadyLinked: string;
    create: {
      title: string;
      description: string;
      nameLabel: string;
      namePlaceholder: string;
      hint: string;
      submit: string;
      creating: string;
      validation: {
        required: string;
        tooShort: string;
        tooLong: string;
      };
    };
    errors: {
      forbidden: string;
      notFound: string;
      conflict: string;
      gone: string;
      badRequest: string;
    };
  };
  users: {
    titleA: string;
    titleB: string;
    subtitle: string;
    forbiddenTitle: string;
    forbiddenDesc: string;
    notFoundTitle: string;
    notFoundDesc: string;
    back: string;
  };
};
