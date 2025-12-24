import { useEffect, useState } from 'react'

const isBrowser = typeof window !== 'undefined'

export const usePersistentState = (key, initialValue) => {
    const [value, setValue] = useState(() => {
        if (!isBrowser) return initialValue
        try {
            const stored = window.localStorage.getItem(key)
            return stored ? JSON.parse(stored) : initialValue
        } catch (error) {
            console.warn('Unable to read localStorage key', key, error)
            return initialValue
        }
    })

    useEffect(() => {
        if (!isBrowser) return
        try {
            window.localStorage.setItem(key, JSON.stringify(value))
        } catch (error) {
            console.warn('Unable to persist localStorage key', key, error)
        }
    }, [key, value])

    return [value, setValue]
}
