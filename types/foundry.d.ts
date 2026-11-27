import type { FoundryDocumentLike, FoundryModuleLike } from "./internal.d.ts";

declare global {
  interface ApplicationPositionLike {
    left?: number;
    top?: number;
    width?: number | "auto";
    height?: number | "auto";
    scale?: number;
    zIndex?: number;
  }

  class FoundryApplicationV2 {
    static DEFAULT_OPTIONS: Record<string, unknown>;
    element: HTMLElement | null;
    options: Record<string, unknown>;
    rendered: boolean;
    position: ApplicationPositionLike;
    constructor(options?: Record<string, unknown>);
    _initializeApplicationOptions(options: Record<string, unknown>): Record<string, unknown>;
    _renderHTML(context: Record<string, unknown>, options: Record<string, unknown>): HTMLElement | Promise<HTMLElement>;
    _replaceHTML(result: HTMLElement, content: HTMLElement, options: Record<string, unknown>): void;
    _onRender(context: Record<string, unknown>, options: Record<string, unknown>): Promise<void> | void;
    _onClose(options?: Record<string, unknown>): void;
    render(options?: boolean | Record<string, unknown>): Promise<this>;
    close(options?: Record<string, unknown>): Promise<this>;
    bringToFront?(): void;
  }

  interface HooksStatic {
    events?: Record<string, Array<{ hook: string; id: number; fn: (...args: unknown[]) => unknown; once?: boolean }>>;
    on(hook: string, fn: (...args: unknown[]) => unknown, options?: { once?: boolean }): number;
    once(hook: string, fn: (...args: unknown[]) => unknown): number;
    off(hook: string, fn: ((...args: unknown[]) => unknown) | number): void;
    call(hook: string, ...args: unknown[]): boolean;
    callAll?(hook: string, ...args: unknown[]): void;
  }

  var Hooks: HooksStatic | undefined;

  var foundry: {
    applications: {
      api: {
        ApplicationV2: typeof FoundryApplicationV2;
      };
    };
    utils: {
      flattenObject?: (obj: Record<string, unknown>, _d?: number) => Record<string, unknown>;
      saveDataToFile?: (data: string, type: string, filename: string) => void;
    };
  } | undefined;

  var game: {
    version?: string;
    system?: { id?: string; version?: string };
    world?: { id?: string; title?: string };
    user?: {
      id?: string;
      name?: string;
      isGM?: boolean;
      role?: number;
      character?: FoundryDocumentLike | null;
    };
    users?: {
      get?: (id: string) => { id: string; name?: string } | undefined;
    };
    i18n: {
      lang: string;
      localize: (key: string) => string;
      format: (key: string, data?: Record<string, unknown>) => string;
    };
    modules: {
      get: (id: string) => FoundryModuleLike | undefined;
      values?: () => Iterable<FoundryModuleLike>;
      [Symbol.iterator]?: () => Iterator<FoundryModuleLike>;
    };
    settings: {
      settings?: Map<string, { scope?: string; config?: boolean; restricted?: boolean }>;
      register: (namespace: string, key: string, config: Record<string, unknown>) => void;
      registerMenu: (namespace: string, key: string, config: Record<string, unknown>) => void;
      get: (namespace: string, key: string) => unknown;
    };
    keybindings: {
      register: (namespace: string, action: string, config: Record<string, unknown>) => void;
    };
    combat?: {
      id?: string;
      started?: boolean;
      round?: number;
      turn?: number;
      visible?: boolean;
      combatant?: { id?: string; name?: string; visible?: boolean; actor?: FoundryDocumentLike | null } | null;
      turns?: Array<{ id?: string; name?: string; visible?: boolean }>;
    } | null;
    combats?: {
      active?: {
        id?: string;
        started?: boolean;
        round?: number;
        turn?: number;
        visible?: boolean;
        combatant?: { id?: string; name?: string; visible?: boolean; actor?: FoundryDocumentLike | null } | null;
        turns?: Array<{ id?: string; name?: string; visible?: boolean }>;
      } | null;
    };
    collections?: Map<string, { get?: (id: string, opts?: unknown) => FoundryDocumentLike | undefined }>;
    actors?: { get?: (id: string) => FoundryDocumentLike | undefined };
    messages?: { get?: (id: string) => FoundryDocumentLike | undefined };
    socket?: {
      prependAny?: (listener: (event: string, ...args: unknown[]) => void) => void;
      offAny?: (listener: (event: string, ...args: unknown[]) => void) => void;
    };
  } | undefined;

  var ui: {
    notifications?: {
      info?: (message: string, options?: Record<string, unknown>) => unknown;
      warn?: (message: string, options?: Record<string, unknown>) => unknown;
      error?: (message: string, options?: Record<string, unknown>) => unknown;
      success?: (message: string, options?: Record<string, unknown>) => unknown;
      notify?: (message: string, type?: string, options?: Record<string, unknown>) => unknown;
      update?: (notification: unknown, update?: Record<string, unknown>) => unknown;
    };
    combat?: {
      viewed?: {
        combatants?: { get?: (id: string) => { id?: string; uuid?: string; visible?: boolean; actor?: FoundryDocumentLike | null } | undefined };
      } | null;
    };
  } | undefined;

  var canvas: {
    ready?: boolean;
    scene?: { id?: string } | null;
    tokens?: {
      controlled?: Array<{ document?: FoundryDocumentLike; actor?: FoundryDocumentLike | null; center?: { x: number; y: number } }>;
      get?: (id: string) => { center?: { x: number; y: number }; control?: (opts?: unknown) => unknown } | undefined;
    };
    animatePan?: (view: { x: number; y: number; scale?: number }) => Promise<unknown> | void;
  } | undefined;

  var CONFIG: {
    ui?: {
      notifications?: {
        prototype: {
          notify: (message: string, type?: string, options?: Record<string, unknown>) => unknown;
          update: (notification: unknown, update?: Record<string, unknown>) => unknown;
        };
      };
    };
  } | undefined;

  var CONST: {
    USER_ROLE_NAMES?: Record<number, string>;
  } | undefined;

  var fromUuidSync: ((uuid: string) => FoundryDocumentLike | null) | undefined;
}

export {};
