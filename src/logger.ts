export interface Logger {
  (formatter: any, ...args: any[]): void
  error: (formatter: any, ...args: any[]) => void
  trace: (formatter: any, ...args: any[]) => void
  enabled: boolean
}

export interface LoggerFactory { (name: string): Logger }

export function dummyLogger (): Logger {
  const logger: Logger = ((formatter: any, ...args: any[]): void => {}) as any
  logger.enabled = false
  logger.error = (formatter: any, ...args: any[]) => void {}
  logger.trace = (formatter: any, ...args: any[]) => void {}
  return logger
}
