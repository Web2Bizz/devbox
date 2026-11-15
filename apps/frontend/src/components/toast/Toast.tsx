// REMOVED — custom `ToastProvider`/`useToast` deleted per review decision.
// Use the kit sonner toast instead: `import { Toaster, toast } from '@web2bizz/ui/widgets'`
// (`Toaster` is mounted once in `src/providers.tsx`; call `toast.error(...)`
// with a stable `id` for dedupe and `action` for Retry).
// This stub file is pending physical deletion (`rm -rf src/components/toast`)
// by the router shell step — do not add imports here.
export {};
