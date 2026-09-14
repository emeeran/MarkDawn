import { create } from 'zustand'

interface ToastStore {
  message: string | null
  show: (message: string) => void
}

let timer: ReturnType<typeof setTimeout> | undefined

export const useToast = create<ToastStore>((setState) => ({
  message: null,
  show(message) {
    setState({ message })
    clearTimeout(timer)
    timer = setTimeout(() => setState({ message: null }), 4000)
  },
}))
