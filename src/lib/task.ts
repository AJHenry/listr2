import { Observable, Subject } from 'rxjs'
import { Readable } from 'stream'

import {
  ListrRendererFactory,
  ListrGetRendererTaskOptions,
  ListrContext,
  ListrError,
  ListrEvent,
  ListrOptions,
  ListrTask,
  ListrTaskObject,
  ListrTaskWrapper,
  PromptError,
  ListrGetRendererOptions,
  StateConstants
} from '@interfaces/listr.interface'
import { stateConstants } from '@interfaces/state.constants'
import { Listr } from '@root/index'
import { getRenderer } from '@utils/renderer'
import { generateUUID } from '@utils/uuid'

export class Task<Ctx, Renderer extends ListrRendererFactory> extends Subject<ListrEvent> implements ListrTaskObject<ListrContext, Renderer> {
  public id: ListrTaskObject<Ctx, Renderer>['id']
  public title: ListrTaskObject<Ctx, Renderer>['title']
  public task: ListrTaskObject<Ctx, Renderer>['task']
  public skip: ListrTaskObject<Ctx, Renderer>['skip']
  public subtasks: ListrTaskObject<Ctx, any>['subtasks']
  public state: ListrTaskObject<Ctx, Renderer>['state']
  public output: ListrTaskObject<Ctx, Renderer>['output']
  public prompt: boolean | PromptError
  public exitOnError: boolean
  public rendererTaskOptions: ListrGetRendererTaskOptions<Renderer>
  public renderHook$: Subject<void>
  private enabled: boolean
  private enabledFn: ListrTask<Ctx, Renderer>['enabled']

  constructor (public listr: Listr<Ctx, any, any>, public tasks: ListrTask<Ctx, any>, public options: ListrOptions, public rendererOptions: ListrGetRendererOptions<Renderer>) {
    super()

    // this kind of randomness is enough for task ids
    this.id = generateUUID()

    this.title = this.tasks?.title
    this.task = this.tasks.task
    // parse functions
    this.skip = this.tasks?.skip || ((): boolean => false)
    this.enabledFn = this.tasks?.enabled || ((): boolean => true)
    // task options
    this.rendererTaskOptions = this.tasks.options

    this.renderHook$ = this.listr.renderHook$
    this.subscribe(() => {
      this.renderHook$.next()
    })
  }

  set state$ (state: StateConstants) {
    this.state = state

    this.next({
      type: 'STATE',
      data: state
    })
  }

  async check (ctx: Ctx): Promise<void> {
    // Check if a task is enabled or disabled
    if (this.state === undefined) {
      if (typeof this.enabledFn === 'function') {
        this.enabled = await this.enabledFn(ctx)
      } else {
        this.enabled = this.enabledFn
      }

      this.next({
        type: 'ENABLED',
        data: this.enabled
      })
    }
  }

  hasSubtasks (): boolean {
    return this.subtasks?.length > 0
  }

  isPending (): boolean {
    return this.state === stateConstants.PENDING
  }

  isSkipped (): boolean {
    return this.state === stateConstants.SKIPPED
  }

  isCompleted (): boolean {
    return this.state === stateConstants.COMPLETED
  }

  hasFailed (): boolean {
    return this.state === stateConstants.FAILED
  }

  isEnabled (): boolean {
    return this.enabled
  }

  hasTitle (): boolean {
    return typeof this?.title === 'string'
  }

  isPrompt (): boolean {
    if (this.prompt) {
      return true
    } else {
      return false
    }
  }

  async run (context: Ctx, wrapper: ListrTaskWrapper<Ctx, Renderer>): Promise<void> {
    const handleResult = (result): Promise<any> => {
      if (result instanceof Listr) {
        // Detect the subtask
        // assign options
        result.options = { ...this.options, ...result.options }

        // switch to silent renderer since already rendering
        const rendererClass = getRenderer('silent')
        result.rendererClass = rendererClass.renderer
        result.renderHook$.subscribe((): void => {
          this.renderHook$.next()
        })

        // assign subtasks
        this.subtasks = result.tasks

        this.next({ type: 'SUBTASK' })

        result = result.run(context)

        // eslint-disable-next-line no-empty
      } else if (this.isPrompt()) {
        // do nothing, it is already being handled
      } else if (result instanceof Promise) {
        // Detect promise
        result = result.then(handleResult)
      } else if (result instanceof Readable) {
        // Detect stream
        result = new Promise((resolve, reject) => {
          result.on('data', (data: Buffer) => {
            this.output = data.toString()

            this.next({
              type: 'DATA',
              data: data.toString()
            })
          })
          result.on('error', (error: Error) => reject(error))
          result.on('end', () => resolve())
        })
      } else if (result instanceof Observable) {
        // Detect Observable
        result = new Promise((resolve, reject) => {
          result.subscribe({
            next: (data) => {
              this.output = data

              this.next({
                type: 'DATA',
                data
              })
            },
            error: reject,
            complete: resolve
          })
        })
      }

      return result
    }

    // finish the task first
    // Promise.resolve()
    this.state$ = stateConstants.PENDING

    // check if this function wants to be skipped
    let skipped: boolean | string
    if (typeof this.skip === 'function') {
      skipped = await this.skip(context)
    }
    if (skipped) {
      if (typeof skipped === 'string') {
        this.output = skipped
      } else if (this.hasTitle()) {
        this.output = this.title
      }
      this.state$ = stateConstants.SKIPPED
      return
    }

    try {
      // handle the results
      await handleResult(this.task(context, wrapper))

      if (this.isPending()) {
        this.state$ = stateConstants.COMPLETED
      }
    } catch (error) {
      // mark task as failed
      this.state$ = stateConstants.FAILED

      // catch prompt error, this was the best i could do without going crazy
      if (this.prompt instanceof PromptError) {
        // eslint-disable-next-line no-ex-assign
        error = new Error(this.prompt.message)
      }

      // report error
      if (error instanceof ListrError) {
        wrapper.report(error)
        return
      }

      if (!this.hasSubtasks()) {
        // Do not show the message if we have subtasks as the error is already shown in the subtask
        this.title = error.message
      }

      wrapper.report(error)

      // Do not exit when explicitely set to `false`
      if (this.listr.options.exitOnError !== false) {
        throw error
      }
    } finally {
      // Mark the observable as completed
      this.complete()
    }
  }
}
