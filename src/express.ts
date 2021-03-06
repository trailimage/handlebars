import * as fs from 'fs'
import * as path from 'path'
import * as Handlebars from 'handlebars'
import { Cache, merge, is, Encoding, forEachKeyValue } from '@toba/node-tools'
import { placeholder, placeholderContent, each } from './helpers'

const placeholderHelperName = 'block'
const contentHelperName = 'contentFor'
const eachHelperName = 'each'

/**
 * Configuration that applies globally to the Handlebars renderer.
 */
export interface ExpressHandlebarsOptions {
   /**
    * Default layout file name without extension the view templates should be
    * rendered within.
    */
   defaultLayout: string
   /** Folder within Express `views` containing partials. */
   partialsFolder: string
   /** Folder within Express `views` containing layouts. */
   layoutsFolder: string
   /** Whether to cache templates (default is `true`). */
   cacheTemplates: boolean
   /** File extension the renderer should handle. Default is `hbs`. */
   fileExtension: string
}

/**
 * Method called when a template has been rendered.
 */
type RenderCallback = (err: Error | null, output?: string) => void

/**
 * Values set in the Express application with the `app.set(name, value)`
 * syntax.
 */
interface ExpressSettings {
   /** Absolute path to renderable views including partials and layouts. */
   views: string
   filename?: string
   etag: string
   /** `NODE_ENV` value if set. */
   env: string
   'view engine': string
   'x-powered-by': boolean
   'trust proxy': boolean
}

/**
 * Context values available within templates and settings passed with each
 * `render()` call.
 */
export interface RenderContext {
   [key: string]: any
   /** Cache flag injected by Express. */
   cache?: boolean
   settings: ExpressSettings
   /**
    * Layout to render content within. Handlebars doesn't support layouts per se
    * so the layout becomes the view template to render with a `body` block
    * that the given view name is assigned to.
    */
   layout?: string
}

const defaultOptions: ExpressHandlebarsOptions = {
   defaultLayout: 'main',
   partialsFolder: 'partials',
   layoutsFolder: 'layouts',
   cacheTemplates: true,
   fileExtension: 'hbs'
}

/**
 *
 */
export class ExpressHandlebars {
   /** Template file extension that will be handled by this renderer. */
   fileExtension: string
   private options: ExpressHandlebarsOptions
   private cache: Cache<Handlebars.TemplateDelegate<any>>
   private hbs: typeof Handlebars
   private basePath: string
   //private filePattern: RegExp;
   private partialsLoaded = false

   /**
    *
    * @param basePath Fully qualified path to views. This duplicates the
    * Express `views` but is available sooner, before a rendering request,
    * allowing earlier caching of templates.
    */
   constructor(options: Partial<ExpressHandlebarsOptions> = {}) {
      this.options = merge(defaultOptions, options)
      this.hbs = Handlebars.create()
      this.cache = new Cache()
      this.fileExtension = this.options.fileExtension
      this.renderer = this.renderer.bind(this)
      this.registerHelper = this.registerHelper.bind(this)
      //this.filePattern = new RegExp(`\.${this.fileExtension}$`);
      this.options.defaultLayout = this.addExtension(this.options.defaultLayout)
      // register default helpers
      this.registerHelper({
         [placeholderHelperName]: placeholder,
         [contentHelperName]: placeholderContent,
         [eachHelperName]: each
      })
   }

   /**
    * Add file name extension.
    */
   private addExtension = (filePath: string): string =>
      is.empty(filePath) || filePath.endsWith(this.fileExtension)
         ? filePath
         : `${filePath}.${this.fileExtension}`

   /**
    * Extract name of partial (file name without extension) from full path.
    */
   private partialName = (filePath: string): string => {
      const parts = filePath.split(/[/\\]/)
      return parts[parts.length - 1].replace('.' + this.fileExtension, '')
   }

   /**
    * Express standard renderer. Express adds the defined file extention to the
    * view name before passing it.
    *
    * @example
    *    import { ExpressHandlebars } from '@toba/handlebars';
    *    const ehb = new ExpressHandlebars();
    *    app.engine(ehb.name, ehb.renderer);
    *    app.set('views', './views');
    *    app.set('view engine', ehb.name);
    *
    * @see https://expressjs.com/en/advanced/developing-template-engines.html
    */
   async renderer(
      viewPath: string,
      context: RenderContext,
      cb?: RenderCallback
   ) {
      const layout =
         context.layout === undefined
            ? this.options.defaultLayout
            : this.addExtension(context.layout)

      this.basePath = context.settings.views

      if (layout !== null) {
         // render view within the layout, otherwise render without layout
         if (await this.ensurePartialsAreReady(cb)) {
            const bodyTemplate = await this.loadTemplate(viewPath)
            if (is.callable(bodyTemplate)) {
               context.body = bodyTemplate(context)
            }
            viewPath = path.join(
               this.basePath,
               this.options.layoutsFolder,
               layout
            )
         }
      }
      this.render(viewPath, context, cb)
   }

   private async ensurePartialsAreReady(cb?: RenderCallback) {
      if (!this.partialsLoaded) {
         try {
            this.loadPartials(this.options.partialsFolder)
            this.partialsLoaded = true
         } catch (err) {
            if (is.callable(cb)) cb(err)
         }
      }
      return this.partialsLoaded
   }

   private async render(
      viewPath: string,
      context: RenderContext,
      cb?: RenderCallback
   ) {
      if (await this.ensurePartialsAreReady(cb)) {
         try {
            const template = await this.loadTemplate(viewPath)
            if (is.callable(cb) && is.callable(template)) {
               cb(null, template(context))
            }
         } catch (err) {
            if (is.callable(cb)) cb(err)
         }
      }
   }

   /**
    * Load template from cache or from file system if not cached.
    * @param registerAsPartial Whether to add template to render option
    * partials
    */
   private loadTemplate = (
      filePath: string,
      registerAsPartial = false
   ): Promise<Handlebars.TemplateDelegate | null> =>
      new Promise((resolve, reject) => {
         if (this.cache.contains(filePath)) {
            resolve(this.cache.get(filePath))
         } else {
            fs.readFile(
               filePath,
               { encoding: Encoding.UTF8 },
               (err: Error, content: string) => {
                  if (err) {
                     reject(err)
                     return
                  }
                  const template = this.hbs.compile(content)
                  this.cache.add(filePath, template)

                  if (registerAsPartial) {
                     this.hbs.registerPartial(
                        this.partialName(filePath),
                        template
                     )
                  }
                  resolve(template)
               }
            )
         }
      })

   /**
    * Add helper function to template context.
    */
   registerHelper(name: string, fn: Handlebars.HelperDelegate): void
   /**
    * Add map of helper functions to template context.
    */
   registerHelper(map: { [key: string]: Handlebars.HelperDelegate }): void
   registerHelper(
      mapOrName: string | { [key: string]: Handlebars.HelperDelegate },
      fn?: Handlebars.HelperDelegate
   ) {
      if (is.text(mapOrName)) {
         this.hbs.registerHelper(name, fn!)
      } else {
         forEachKeyValue(mapOrName, (key, value) =>
            this.hbs.registerHelper(key, value)
         )
      }
   }

   /**
    * Precompile templates in given folders relative to a base path.
    */
   private loadPartials(...folders: string[]): void {
      folders.forEach(async f => {
         const fullPath = path.join(this.basePath, f)
         const files = fs.readdirSync(fullPath)
         await Promise.all(
            files
               .filter(fileName => fileName.endsWith(this.fileExtension))
               .map(fileName =>
                  this.loadTemplate(path.join(fullPath, fileName), true)
               )
         )
      })
   }
}
