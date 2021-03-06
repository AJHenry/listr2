import Enquirer from 'enquirer'

import { PromptOptions, PromptSettings } from './prompt.interface'
import { PromptError } from '@interfaces/listr.interface'
import { TaskWrapper } from '@root/lib/task-wrapper'

export async function createPrompt (options: PromptOptions | PromptOptions<true>[], settings?: PromptSettings): Promise<any> {
  // override cancel callback
  let cancelCallback: PromptSettings['cancelCallback']
  /* istanbul ignore if */
  if (settings?.cancelCallback) {
    cancelCallback = settings.cancelCallback
  } else {
    cancelCallback = defaultCancelCallback
  }

  // assign default if there is single prompt
  /* istanbul ignore else if */
  if (!Array.isArray(options)) {
    options = [ { ...options, name: 'default' } ]
  } else if (options.length === 1) {
    options = options.reduce((o, option) => {
      return [ ...o, Object.assign(option, { name: 'default' }) ]
    }, [])
  }

  // assign default enquirer options}
  options = options.reduce((o, option) => {
    return [ ...o, Object.assign(option, { stdout: settings?.stdout ?? this.stdout(), onCancel: cancelCallback.bind(this, settings) }) ]
  }, [])

  let enquirer: Enquirer
  if (settings?.enquirer) {
    // injected enquirer
    enquirer = settings.enquirer
  } else {
    try {
      enquirer = ((await import('enquirer')) as any).default
    } catch (e) /* istanbul ignore next */ {
      this.task.prompt = new PromptError('Enquirer is a peer dependency that must be installed seperately.')
      throw new Error(e)
    }
  }

  // return default name if it is single prompt
  const response = (await enquirer.prompt(options as any)) as any

  if (options.length === 1) {
    return response.default
  } else {
    return response
  }
}

function defaultCancelCallback (settings: PromptSettings): string | Error | PromptError | void {
  const errorMsg = 'Cancelled prompt.'

  if (settings?.error === true) {
    /* istanbul ignore next */ throw new Error(errorMsg)
  } else if (this instanceof TaskWrapper) {
    this.task.prompt = new PromptError(errorMsg)
  } /* istanbul ignore next */ else {
    return errorMsg
  }
}
