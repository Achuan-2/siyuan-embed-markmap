import {
  Dialog,
  Plugin,
  fetchPost,
  IWebSocketData,
} from "siyuan";
import "@/index.scss";
import "@/vidtor/index.css"
import PluginInfoString from '@/../plugin.json';
import {
  getImageSizeFromBase64,
  locatePNGtEXt,
  replaceSubArray,
  arrayToBase64,
  base64ToArray,
  base64ToUnicode,
  unicodeToBase64,
  blobToDataURL,
  dataURLToBlob,
  HTMLToElement,
} from "./utils";
import { Transformer } from 'markmap-lib';
import { Markmap, loadCSS, loadJS } from 'markmap-view';
import Vditor from 'vditor';

let PluginInfo = {
  version: '',
}
try {
  PluginInfo = PluginInfoString
} catch (err) {
  console.log('Plugin info parse error: ', err)
}
const {
  version,
} = PluginInfo

const STORAGE_NAME = "config.json";

export default class MarkmapPlugin extends Plugin {
  // Run as mobile
  public isMobile: boolean
  // Run in browser
  public isBrowser: boolean
  // Run as local
  public isLocal: boolean
  // Run in Electron
  public isElectron: boolean
  // Run in window
  public isInWindow: boolean
  public platform: SyFrontendTypes
  public readonly version = version

  private _mutationObserver;
  private _openMenuImageHandler;
  private _hoverImageHandler;

  private settingItems: SettingItem[];

  async onload() {
    this.initSetting();

    this._mutationObserver = this.setAddImageBlockMuatationObserver(document.body, (blockElement: HTMLElement) => {
      if (this.data[STORAGE_NAME].labelDisplay === "noLabel") return;

      const imageElement = blockElement.querySelector("img") as HTMLImageElement;
      if (imageElement) {
        if (blockElement.getAttribute("custom-markmap")) {
          const imageURL = imageElement.getAttribute("data-src");
          this.getMarkmapImageInfo(imageURL, false).then((imageInfo) => {
            this.updateAttrLabel(imageInfo, blockElement);
          });
        }
      }
    });

    this.protyleSlash = [{
      filter: ["mindmap", "markmap"],
      id: "markmap",
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconImage"></use></svg><span class="b3-list-item__text">Mark Map</span></div>`,
      callback: (_protyle, nodeElement) => {
        this.newMarkmapImage(nodeElement.dataset.nodeId, (imageInfo) => {
          // 始终使用 dialog 弹窗进行编辑（移除 tab/dialog 配置选择）
          this.openEditDialog(imageInfo, nodeElement.dataset.nodeId);
        });
      },
    }];

    this._openMenuImageHandler = this.openMenuImageHandler.bind(this);
    this.eventBus.on("open-menu-image", this._openMenuImageHandler);

    // hover handler: insert edit button for custom-markmap images
    let _isProcessingHover = false;
    this._hoverImageHandler = (e: MouseEvent) => {
      try {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const imgContainer = target.closest('[data-type="img"]') as HTMLElement | null;
        if (!imgContainer) return;

        // throttle small bursts
        if (_isProcessingHover) return;
        _isProcessingHover = true;
        setTimeout(() => { _isProcessingHover = false; }, 100);

        // only for markmap images inside a NodeParagraph with custom-markmap attr
        const blockElement = imgContainer.closest("div[data-type='NodeParagraph']") as HTMLElement | null;
        if (!blockElement) return;
        if (!blockElement.getAttribute('custom-markmap')) return;

        // avoid inserting twice
        if (imgContainer.querySelector('.cst-edit-markmap')) return;

        const action = imgContainer.querySelector('.protyle-action') as HTMLElement | null;
        if (!action) return;

        // adjust existing action icon corners
        const actionIcon = action.querySelector('.protyle-icon') as HTMLElement | null;
        if (actionIcon) {
          actionIcon.style.borderTopLeftRadius = '0';
          actionIcon.style.borderBottomLeftRadius = '0';
        }

        const editHtml = `
            <span class="protyle-icon protyle-icon--only protyle-custom cst-edit-markmap" 
                  aria-label="编辑MarkMap"
                  style="border-top-right-radius:0;border-bottom-right-radius:0;cursor:pointer;">
                <svg class="svg"><use xlink:href="#iconEdit"></use></svg>
            </span>`;
        action.insertAdjacentHTML('afterbegin', editHtml);

        const editBtn = imgContainer.querySelector('.cst-edit-markmap') as HTMLElement | null;
        if (!editBtn) return;

        const onEditClick = (ev: Event) => {
          try {
            ev.stopPropagation();
            const imgEl = imgContainer.querySelector('img') as HTMLImageElement | null;
            const imageURL = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src');
            if (!imageURL) return;
            // fetch image info and open dialog
            this.getMarkmapImageInfo(imageURL, true).then((imageInfo: MarkmapImageInfo | null) => {
              if (imageInfo) {
                const blockID = blockElement ? blockElement.getAttribute('data-node-id') : undefined;
                this.openEditDialog(imageInfo, blockID || undefined);
              }
            }).catch(err => { console.error('getMarkmapImageInfo error', err); });
          } catch (err) {
            console.error('onEditClick error', err);
          }
        };

        editBtn.addEventListener('click', onEditClick);
        // keep a small cleanup: if the image container is removed later, unbind the listener
        const mo = new MutationObserver((mutations) => {
          for (const m of mutations) {
            m.removedNodes.forEach(node => {
              if (node === imgContainer) {
                try { editBtn.removeEventListener('click', onEditClick); } catch (e) {}
                try { mo.disconnect(); } catch (e) {}
              }
            });
          }
        });
        mo.observe(imgContainer.parentElement || document.body, { childList: true });
      } catch (err) {
        console.error('hover handler error', err);
      }
    };
    document.addEventListener('mouseover', this._hoverImageHandler as EventListener);
  }

  onunload() {
    if (this._mutationObserver) this._mutationObserver.disconnect();
    if (this._openMenuImageHandler) this.eventBus.off("open-menu-image", this._openMenuImageHandler);
    if (this._hoverImageHandler) document.removeEventListener('mouseover', this._hoverImageHandler as EventListener);
  }

  uninstall() {
    this.removeData(STORAGE_NAME);
  }

  openSetting() {
    const dialogHTML = `
<div class="b3-dialog__content"></div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-type="cancel">${window.siyuan.languages.cancel}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-type="confirm">${window.siyuan.languages.save}</button>
</div>
    `;

    const dialog = new Dialog({
      title: this.displayName,
      content: dialogHTML,
      width: this.isMobile ? "92vw" : "768px",
      height: "80vh",
      hideCloseIcon: this.isMobile,
    });

    // 配置的处理拷贝自思源源码
    const contentElement = dialog.element.querySelector(".b3-dialog__content");
    this.settingItems.forEach((item) => {
      let html = "";
      let actionElement = item.actionElement;
      if (!item.actionElement && item.createActionElement) {
        actionElement = item.createActionElement();
      }
      const tagName = actionElement?.classList.contains("b3-switch") ? "label" : "div";
      if (typeof item.direction === "undefined") {
        item.direction = (!actionElement || "TEXTAREA" === actionElement.tagName) ? "row" : "column";
      }
      if (item.direction === "row") {
        html = `<${tagName} class="b3-label">
    <div class="fn__block">
        ${item.title}
        ${item.description ? `<div class="b3-label__text">${item.description}</div>` : ""}
        <div class="fn__hr"></div>
    </div>
</${tagName}>`;
      } else {
        html = `<${tagName} class="fn__flex b3-label config__item">
    <div class="fn__flex-1">
        ${item.title}
        ${item.description ? `<div class="b3-label__text">${item.description}</div>` : ""}
    </div>
    <span class="fn__space${actionElement ? "" : " fn__none"}"></span>
</${tagName}>`;
      }
      contentElement.insertAdjacentHTML("beforeend", html);
      if (actionElement) {
        if (["INPUT", "TEXTAREA"].includes(actionElement.tagName)) {
          dialog.bindInput(actionElement as HTMLInputElement, () => {
            (dialog.element.querySelector(".b3-dialog__action [data-type='confirm']") as HTMLElement).dispatchEvent(new CustomEvent("click"));
          });
        }
        if (item.direction === "row") {
          contentElement.lastElementChild.lastElementChild.insertAdjacentElement("beforeend", actionElement);
          actionElement.classList.add("fn__block");
        } else {
          actionElement.classList.remove("fn__block");
          actionElement.classList.add("fn__flex-center", "fn__size200");
          contentElement.lastElementChild.insertAdjacentElement("beforeend", actionElement);
        }
      }
    });

    (dialog.element.querySelector(".b3-dialog__action [data-type='cancel']") as HTMLElement).addEventListener("click", () => {
      dialog.destroy();
    });
    (dialog.element.querySelector(".b3-dialog__action [data-type='confirm']") as HTMLElement).addEventListener("click", () => {
      this.data[STORAGE_NAME].labelDisplay = (dialog.element.querySelector("[data-type='labelDisplay']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].embedImageFormat = (dialog.element.querySelector("[data-type='embedImageFormat']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].fullscreenEdit = (dialog.element.querySelector("[data-type='fullscreenEdit']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].themeMode = (dialog.element.querySelector("[data-type='themeMode']") as HTMLSelectElement).value;
      this.saveData(STORAGE_NAME, this.data[STORAGE_NAME]);
      dialog.destroy();
    });
  }

  private async initSetting() {
    await this.loadData(STORAGE_NAME);
    if (!this.data[STORAGE_NAME]) this.data[STORAGE_NAME] = {};
    if (typeof this.data[STORAGE_NAME].labelDisplay === 'undefined') this.data[STORAGE_NAME].labelDisplay = "showLabelOnHover";
    if (typeof this.data[STORAGE_NAME].embedImageFormat === 'undefined') this.data[STORAGE_NAME].embedImageFormat = "svg";
    if (typeof this.data[STORAGE_NAME].fullscreenEdit === 'undefined') this.data[STORAGE_NAME].fullscreenEdit = false;
    if (typeof this.data[STORAGE_NAME].themeMode === 'undefined') this.data[STORAGE_NAME].themeMode = "themeLight";

    this.settingItems = [
      {
        title: this.i18n.labelDisplay,
        direction: "column",
        description: this.i18n.labelDisplayDescription,
        createActionElement: () => {
          const options = ["noLabel", "showLabelAlways", "showLabelOnHover"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].labelDisplay);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${this.i18n[option]}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="labelDisplay">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.embedImageFormat,
        direction: "column",
        description: this.i18n.embedImageFormatDescription,
        createActionElement: () => {
          const options = ["svg", "png"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].embedImageFormat);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${option}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="embedImageFormat">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.fullscreenEdit,
        direction: "column",
        description: this.i18n.fullscreenEditDescription,
        createActionElement: () => {
          const element = HTMLToElement(`<input type="checkbox" class="b3-switch fn__flex-center" data-type="fullscreenEdit">`) as HTMLInputElement;
          element.checked = this.data[STORAGE_NAME].fullscreenEdit;
          return element;
        },
      },
      
      {
        title: this.i18n.themeMode,
        direction: "column",
        description: this.i18n.themeModeDescription,
        createActionElement: () => {
          const options = ["themeLight", "themeDark", "themeOS"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].themeMode);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${window.siyuan.languages[option]}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="themeMode">${optionsHTML}</select>`);
        },
      },
    ];
  }



  public setAddImageBlockMuatationObserver(element: HTMLElement, callback: (blockElement: HTMLElement) => void): MutationObserver {
    const mutationObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const addedElement = node as HTMLElement;
              if (addedElement.matches("div[data-type='NodeParagraph']")) {
                if (addedElement.querySelector(".img[data-type='img'] img")) {
                  callback(addedElement as HTMLElement);
                }
              } else {
                addedElement.querySelectorAll("div[data-type='NodeParagraph']").forEach((blockElement: HTMLElement) => {
                  if (blockElement.querySelector(".img[data-type='img'] img")) {
                    callback(blockElement);
                  }
                })
              }
            }
          });
        }
      }
    });

    mutationObserver.observe(element, {
      childList: true,
      subtree: true
    });

    return mutationObserver;
  }

  public async getMarkmapImageInfo(imageURL: string, reload: boolean): Promise<MarkmapImageInfo | null> {
    const imageURLRegex = /^assets\/.+\.(?:svg|png)$/;
    if (!imageURLRegex.test(imageURL)) return null;

    const imageContent = await this.getMarkmapImage(imageURL, reload);
    if (!imageContent) return null;
    // 对 markmap 的图片，我们不依赖 mxfile 标记，直接返回图片信息
    const imageInfo: MarkmapImageInfo = {
      imageURL: imageURL,
      data: imageContent,
      format: imageURL.endsWith(".svg") ? "svg" : "png",
    }
    return imageInfo;
  }

  public getPlaceholderImageContent(format: 'svg' | 'png'): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="183"><rect width="100%" height="100%" fill="#ffffff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="16" fill="#888">MarkMap</text></svg>`;
    const base64 = btoa(unescape(encodeURIComponent(svg)));
    if (format === 'svg') return `data:image/svg+xml;base64,${base64}`;
    // Fallback: return svg data URL even for png to ensure a valid data URL is returned
    return `data:image/svg+xml;base64,${base64}`;
  }



  public newMarkmapImage(blockID: string, callback?: (imageInfo: MarkmapImageInfo) => void) {
    const format = this.data[STORAGE_NAME].embedImageFormat;
    const imageName = `markmap-image-${window.Lute.NewNodeID()}.${format}`;
    const placeholderImageContent = this.getPlaceholderImageContent(format);
    const blob = dataURLToBlob(placeholderImageContent);
    const file = new File([blob], imageName, { type: blob.type });
    const formData = new FormData();
    formData.append('path', `data/assets/${imageName}`);
    formData.append('file', file);
    formData.append('isDir', 'false');
    fetchPost('/api/file/putFile', formData, () => {
      const imageURL = `assets/${imageName}`;
      fetchPost('/api/block/updateBlock', {
        id: blockID,
        data: `![](${imageURL})`,
        dataType: "markdown",
      });
      // 初始化空思维导图到块属性（使用 Markdown 作为 markmap 的数据格式）
      const initial = `# 根节点\n\n`;
      try {
        fetchPost('/api/attr/setBlockAttrs', { id: blockID, attrs: { 'custom-markmap': initial } }, () => { });
      } catch (err) { }

      const imageInfo: MarkmapImageInfo = {
        imageURL: imageURL,
        data: placeholderImageContent,
        format: format,
      };
      if (callback) {
        callback(imageInfo);
      }
    });
  }

  public async getMarkmapImage(imageURL: string, reload: boolean): Promise<string> {
    const response = await fetch(imageURL, { cache: reload ? 'reload' : 'default' });
    if (!response.ok) return "";
    const blob = await response.blob();
    return await blobToDataURL(blob);
  }

  public updateMarkmapImage(imageInfo: MarkmapImageInfo, callback?: (response: IWebSocketData) => void) {
    if (!imageInfo.data) {
      imageInfo.data = this.getPlaceholderImageContent(imageInfo.format);
    }
    const blob = dataURLToBlob(imageInfo.data);
    const file = new File([blob], imageInfo.imageURL.split('/').pop(), { type: blob.type });
    const formData = new FormData();
    formData.append("path", 'data/' + imageInfo.imageURL);
    formData.append("file", file);
    formData.append("isDir", "false");
    fetchPost("/api/file/putFile", formData, callback);
  }

  public updateAttrLabel(imageInfo: MarkmapImageInfo, blockElement: HTMLElement) {
    if (!imageInfo) return;

    if (this.data[STORAGE_NAME].labelDisplay === "noLabel") return;

    const attrElement = blockElement.querySelector(".protyle-attr") as HTMLDivElement;
    if (attrElement) {
      const pageCount = (base64ToUnicode(imageInfo.data.split(',').pop()).match(/name(?:=&quot;|%3D%22)/g) || []).length;
      const labelHTML = `<span>Mark Map${pageCount > 1 ? `:${pageCount}` : ''}</span>`;
      let labelElement = attrElement.querySelector(".label--embed-markmap") as HTMLDivElement;
      if (labelElement) {
        labelElement.innerHTML = labelHTML;
      } else {
        labelElement = document.createElement("div");
        labelElement.classList.add("label--embed-markmap");
        if (this.data[STORAGE_NAME].labelDisplay === "showLabelAlways") {
          labelElement.classList.add("label--embed-markmap--always");
        }
        labelElement.innerHTML = labelHTML;
        attrElement.prepend(labelElement);
      }
    }
  }

  private openMenuImageHandler({ detail }) {
    const selectedElement = detail.element;
    const imageElement = selectedElement.querySelector("img") as HTMLImageElement;
    if (!imageElement) return;
    const imageURL = imageElement.dataset.src;
    const blockElement = selectedElement.closest("div[data-type='NodeParagraph']") as HTMLElement;
    if (!blockElement) return;

    if (blockElement.getAttribute("custom-markmap")) {
      const blockID = blockElement.getAttribute("data-node-id");
      this.getMarkmapImageInfo(imageURL, true).then((imageInfo: MarkmapImageInfo) => {
        if (imageInfo) {
              window.siyuan.menus.menu.addItem({
            id: "edit-mindmap",
            icon: 'iconEdit',
            label: `Edit Mark Map`,
            index: 1,
            click: () => {
                  // 始终使用 dialog 编辑
                  this.openEditDialog(imageInfo, blockID);
            }
          });
        }
      })
    }
  }

  public openEditDialog(imageInfo: MarkmapImageInfo, blockID?: string) {
    if (blockID) imageInfo.blockID = blockID;
    const editDialogHTML = `
  <div class="markmap-edit-dialog" style="height:100%;display:flex;flex-direction:column;">
    <div class="edit-dialog-header resize__move"></div>
    <div class="edit-dialog-container" style="flex:1;display:flex;flex-direction:row;align-items:stretch;gap:0;height:100%;position:relative;">
      <div class="edit-dialog-editor" style="width:40%;display:flex;flex-direction:column;border-right:2px solid #e0e0e0;min-width:220px;">
        <div class="editor-header" style="padding:15px 20px;background-color:#fff;border-bottom:1px solid #e0e0e0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:18px;color:#333;">📝 Markdown 编辑器</h2>
        </div>
        <div id="vditor-editor" style="flex:1;height:100%;width:100%;"></div>
      </div>
      <div class="resize-handle" style="opacity:0;width:4px;background-color:#e0e0e0;cursor:col-resize;z-index:1000;transition:background-color 0.2s;position:absolute;top:0;height:100%;left:40%;">
      </div>
      <div class="edit-dialog-preview" style="width:60%;display:flex;flex-direction:column;min-width:320px;">
        <div class="preview-header" style="padding:15px 20px;background-color:#fff;border-bottom:1px solid #e0e0e0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:18px;color:#333;">🗺️ 思维导图预览</h2>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-secondary" id="markmap-fit-btn" style="padding:8px 16px;border:none;border-radius:5px;cursor:pointer;font-size:14px;font-weight:500;background-color:#2196F3;color:white;">📍 适应窗口</button>
            <button class="btn btn-primary" id="markmap-export-btn" style="padding:8px 16px;border:none;border-radius:5px;cursor:pointer;font-size:14px;font-weight:500;background-color:#4CAF50;color:white;">📥 导出 SVG</button>
            <button class="btn btn-primary" id="markmap-copy-png-btn" style="padding:8px 16px;border:none;border-radius:5px;cursor:pointer;font-size:14px;font-weight:500;background-color:#9C27B0;color:white;">📋 复制 PNG</button>
          </div>
        </div>
        <div style="flex:1;padding:8px;background:#fff;overflow:auto;">
          <svg id="markmap" style="width:100%;height:100%;display:block"></svg>
        </div>
      </div>
    </div>
  </div>
    `;

    const dialogDestroyCallbacks: Array<() => void> = [];

    const dialog = new Dialog({
      content: editDialogHTML,
      width: this.isMobile ? "92vw" : "90vw",
      height: "80vh",
      hideCloseIcon: this.isMobile,
      destroyCallback: () => {
        if (vditorInstance) {
          vditorInstance.destroy();
          vditorInstance = null;
        }
        dialogDestroyCallbacks.forEach(callback => callback());
      },
    });

    // 注：避免思源编辑器变为半透明，注入样式覆盖可能的透明效果，便于查看实时预览
    const styleId = 'siyuan-embed-markmap-no-transparency';
    if (!document.getElementById(styleId)) {
      const styleEl = document.createElement('style');
      styleEl.id = styleId;
      styleEl.textContent = `
        .protyle, .layout__container, .layout__main, .layout-editor, .protyle__content {
          opacity: 1 !important;
          filter: none !important;
        }

        .btn {
          padding: 8px 16px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          transition: all 0.2s;
          margin-left: 10px;
        }
        .btn-secondary {
          background-color: #2196F3;
          color: white;
        }
        svg:hover{
          color: inherit !important;
        }
        .btn-secondary:hover {
          background-color: #0b7dda;
          transform: translateY(-1px);
          box-shadow: 0 3px 6px rgba(0, 0, 0, 0.15);
        }
        .btn:active {
          transform: translateY(0);
        }
      `;
      document.head.appendChild(styleEl);
      dialogDestroyCallbacks.push(() => {
        const el = document.getElementById(styleId);
        if (el) el.remove();
      });
    }



    const svgEl = dialog.element.querySelector('#markmap') as SVGElement;
    const resizeHandle = dialog.element.querySelector('.resize-handle') as HTMLElement;
    const editorPanel = dialog.element.querySelector('.edit-dialog-editor') as HTMLElement;
    const previewPanel = dialog.element.querySelector('.edit-dialog-preview') as HTMLElement;

    // Initialize Vditor
    let vditorInstance: Vditor | null = null;
    const initVditor = async (initialValue: string) => {
      vditorInstance = new Vditor('vditor-editor', {
        height: '100%',
        mode: 'ir', // Instant Rendering mode, similar to Typora
        value: initialValue,
        placeholder: '# Write markdown for markmap',
        cache: { enable: false },
        toolbar: [
          'emoji',
          'headings',
          'bold',
          'italic',
          'strike',
          '|',
          'line',
          'quote',
          'list',
          'ordered-list',
          'check',
          '|',
          'code',
          'inline-code',
          'link',
          'table',
          '|',
          'undo',
          'redo',
          '|',
          'edit-mode', // Switch between IR and SV modes
          'outline',
        ],
        counter: { enable: true, type: 'markdown' },
        outline: { enable: false, position: 'right' },
        input: (value: string) => {
          renderMarkmap(value);
          debouncedSave(value);
        },
        after: () => {
          console.log('Vditor initialized');
          renderMarkmap(initialValue);
        },
      });
    };

    // ensure resize handle height and initial left matches editor width
    try {
      resizeHandle.style.height = '100%';
      // If editorPanel.style.width is a percent like '40%', use it directly, otherwise compute percent
      if (editorPanel.style.width && editorPanel.style.width.trim().endsWith('%')) {
        resizeHandle.style.left = editorPanel.style.width;
      } else {
        const container = dialog.element.querySelector('.edit-dialog-container') as HTMLElement;
        const containerRect = container.getBoundingClientRect();
        const edRect = editorPanel.getBoundingClientRect();
        const leftPercent = containerRect.width > 0 ? (edRect.width / containerRect.width) * 100 : 40;
        resizeHandle.style.left = `${leftPercent}%`;
      }
    } catch (e) {
      // ignore if elements not ready
    }

    // fitView function (exposed to window so the dialog button can call it)
    const fitView = () => {
      if (mmInstance && typeof mmInstance.fit === 'function') {
        try {
          mmInstance.fit();
        } catch (e) {
          console.error('fitView error', e);
        }
      }
    };
    // expose to window for onclick in dialog (also cleaned up on destroy)
    (window as any).fitView = fitView;
    dialogDestroyCallbacks.push(() => {
      try {
        delete (window as any).fitView;
      } catch (e) {}
    });

    // resize handle logic
    let isResizing = false;
    const startResize = (_e: MouseEvent) => {
      isResizing = true;
      resizeHandle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };
    const doResize = (e: MouseEvent) => {
      if (!isResizing) return;
      const container = dialog.element.querySelector('.edit-dialog-container') as HTMLElement;
      const containerRect = container.getBoundingClientRect();
      const newLeftWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
      if (newLeftWidth > 20 && newLeftWidth < 80) {
        editorPanel.style.width = `${newLeftWidth}%`;
        previewPanel.style.width = `${100 - newLeftWidth}%`;
        resizeHandle.style.left = `${newLeftWidth}%`;
      }
    };
    const stopResize = () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setTimeout(() => fitView(), 100);
      }
    };
    resizeHandle.addEventListener('mousedown', startResize);
    // wire up fit button in dialog to our function
    const fitBtn = dialog.element.querySelector('#markmap-fit-btn') as HTMLButtonElement | null;
    if (fitBtn) {
      const onFitClick = () => fitView();
      fitBtn.addEventListener('click', onFitClick);
      dialogDestroyCallbacks.push(() => { fitBtn.removeEventListener('click', onFitClick); });
    }

    // Export SVG logic
    const exportBtn = dialog.element.querySelector('#markmap-export-btn') as HTMLButtonElement | null;
    if (exportBtn) {
      const exportHandler = async () => {
        try {
          // clone and serialize SVG
          const svg = svgEl.cloneNode(true) as SVGElement;
          if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const serializer = new XMLSerializer();
          const svgText = serializer.serializeToString(svg);
          const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
          const fileName = `markmap-${Date.now()}.svg`;

          // Prefer File System Access API if available
          if ((window as any).showSaveFilePicker) {
            try {
              const opts = {
                suggestedName: fileName,
                types: [{ description: 'SVG', accept: { 'image/svg+xml': ['.svg'] } }],
              } as any;
              const handle = await (window as any).showSaveFilePicker(opts);
              const writable = await handle.createWritable();
              await writable.write(blob);
              await writable.close();
            } catch (err) {
              // If user cancels or APIs fail, fallback to download
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            }
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }
        } catch (e) {
          console.error('Export SVG error', e);
          try { fetchPost('/api/notification/pushErrMsg', { msg: '导出 SVG 失败：' + e }, () => {}); } catch (err) {}
        }
      };
      exportBtn.addEventListener('click', exportHandler);
      dialogDestroyCallbacks.push(() => { exportBtn.removeEventListener('click', exportHandler); });
    }
    // Copy PNG logic (uses exportSVGDataURL + exportPNGDataURL)
    const copyPngBtn = dialog.element.querySelector('#markmap-copy-png-btn') as HTMLButtonElement | null;
    if (copyPngBtn) {
      const copyPngHandler = async () => {
        try {
          const svgDataURL = exportSVGDataURL();
          if (!svgDataURL) throw new Error('SVG 导出失败');
          const pngDataURL = await exportPNGDataURL(svgDataURL);
          if (!pngDataURL) throw new Error('PNG 生成失败');

          // fetch the data URL to a blob
          const res = await fetch(pngDataURL);
          const blob = await res.blob();

          // Try to write to clipboard using ClipboardItem
          const clipboard = (navigator as any).clipboard;
          if (clipboard && clipboard.write && typeof (window as any).ClipboardItem !== 'undefined') {
            try {
              await clipboard.write([new (window as any).ClipboardItem({ ['image/png']: blob })]);
              try { fetchPost('/api/notification/pushMsg', { msg: 'PNG 已复制到剪贴板', type: 'success' }, () => {}); } catch (e) {}
              return;
            } catch (err) {
              console.warn('Clipboard write failed, falling back to download', err);
            }
          }

          // Fallback: trigger download
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `markmap-${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          try { fetchPost('/api/notification/pushMsg', { msg: '浏览器不支持剪贴板写入，已下载 PNG', type: 'warning' }, () => {}); } catch (e) {}
        } catch (e) {
          console.error('copy PNG error', e);
          try { fetchPost('/api/notification/pushErrMsg', { msg: '复制 PNG 失败：' + e }, () => {}); } catch (err) {}
        }
      };
      copyPngBtn.addEventListener('click', copyPngHandler);
      dialogDestroyCallbacks.push(() => { copyPngBtn.removeEventListener('click', copyPngHandler); });
    }
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
    dialogDestroyCallbacks.push(() => {
      resizeHandle.removeEventListener('mousedown', startResize);
      document.removeEventListener('mousemove', doResize);
      document.removeEventListener('mouseup', stopResize);
    });

    // debounce helper
    const debounce = (fn: (...args: any[]) => void, wait = 300) => {
      let t: any = null;
      return (...args: any[]) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    };

    // render and export functions
    let mmInstance: any = null;
    let transformer: any = null;
    let features: any = null;

    const renderMarkmap = async (markdown: string) => {
      try {
        if (!transformer) transformer = new Transformer();
        const ret = transformer.transform(markdown || '');
        const root = ret.root;
        features = ret.features;

        // load assets if any (safe to ignore in many cases)
        try {
          const assets = transformer.getUsedAssets && transformer.getUsedAssets(features);
          if (assets) {
            const { styles, scripts } = assets;
            if (styles) loadCSS(styles);
            if (scripts) loadJS(scripts);
          }
        } catch (e) { /* ignore */ }

        if (!mmInstance) {
          mmInstance = Markmap.create(svgEl, { duration: 0 });
        }
        mmInstance.setData(root);
        mmInstance.fit();
        // 延迟再次调用 fit 以确保 dialog 完全打开后视图适应
        setTimeout(() => {
          if (mmInstance) mmInstance.fit();
        }, 100);
      } catch (e) {
        console.error('renderMarkmap error', e);
      }
    };

    const exportSVGDataURL = () => {
      try {
        const svgElement = svgEl.cloneNode(true) as SVGElement;
        // compute bbox and set viewBox/width/height
        try {
          const bbox = (svgEl as SVGGraphicsElement).getBBox();
          svgElement.setAttribute('viewBox', `${bbox.x - 20} ${bbox.y - 20} ${bbox.width + 40} ${bbox.height + 40}`);
          svgElement.setAttribute('width', String(bbox.width + 40));
          svgElement.setAttribute('height', String(bbox.height + 40));
        } catch (e) {
          // fallback: do nothing if getBBox fails
        }
        // ensure xmlns
        if (!svgElement.getAttribute('xmlns')) svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!svgElement.getAttribute('xmlns:xlink')) svgElement.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

        // inline computed styles from document.styleSheets when possible
        try {
          const styles = Array.from(document.styleSheets)
            .filter(sheet => {
              try {
                return !!sheet.cssRules;
              } catch (err) {
                return false;
              }
            })
            .reduce((acc, sheet) => {
              try {
                return acc + Array.from((sheet as CSSStyleSheet).cssRules).map(r => r.cssText).join('\n');
              } catch (err) {
                return acc;
              }
            }, '');
          if (styles) {
            const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
            styleEl.textContent = styles;
            svgElement.insertBefore(styleEl, svgElement.firstChild);
          }
        } catch (e) {
          // ignore style inlining errors
        }

        const serializer = new XMLSerializer();
        const svgText = serializer.serializeToString(svgElement);
        const base64 = unicodeToBase64(svgText);
        return `data:image/svg+xml;base64,${base64}`;
      } catch (e) {
        console.error('exportSVGDataURL error', e);
        return null;
      }
    };

    const exportPNGDataURL = async (svgDataURL: string) => {
      try {
        const img = new Image();
        img.src = svgDataURL;
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
        const canvas = document.createElement('canvas');
        canvas.width = img.width || 800;
        canvas.height = img.height || 600;
        const ctx = canvas.getContext('2d');
        ctx!.fillStyle = '#ffffff';
        ctx!.fillRect(0, 0, canvas.width, canvas.height);
        ctx!.drawImage(img, 0, 0);
        return canvas.toDataURL('image/png');
      } catch (e) {
        console.error('exportPNGDataURL error', e);
        return null;
      }
    };

    const doSaveAndUpdateImage = async (markdown: string) => {
      if (!imageInfo.blockID) return;
      try {
        // save block attr
        fetchPost('/api/attr/setBlockAttrs', { id: imageInfo.blockID, attrs: { 'custom-markmap': markdown } }, async (_resp) => {
          // export image content
          let dataURL: string | null = null;
          if (imageInfo.format === 'svg') {
            const svgDataURL = exportSVGDataURL();
            if (svgDataURL) dataURL = svgDataURL;
          } else {
            const svgDataURL = exportSVGDataURL();
            if (svgDataURL) dataURL = await exportPNGDataURL(svgDataURL);
          }
          if (dataURL) {
            imageInfo.data = dataURL;
            imageInfo.data = this.fixImageContent(imageInfo.data);
            this.updateMarkmapImage(imageInfo, () => {
              fetch(imageInfo.imageURL, { cache: 'reload' }).then(() => {
                document.querySelectorAll(`img[data-src='${imageInfo.imageURL}']`).forEach(imageElement => {
                  (imageElement as HTMLImageElement).src = imageInfo.imageURL;
                  const blockElement = imageElement.closest("div[data-type='NodeParagraph']") as HTMLElement;
                  if (blockElement) {
                    this.updateAttrLabel(imageInfo, blockElement);
                  }
                });
              }).catch((err) => { console.error('Failed to reload image:', err); });
            });
          }
        });
      } catch (e) {
        console.error('doSaveAndUpdateImage error', e);
      }
    };

    const debouncedSave = debounce((v: string) => {
      doSaveAndUpdateImage(v);
    }, 300);

    // load initial content from block attr
    if (imageInfo.blockID) {
      try {
        fetchPost('/api/attr/getBlockAttrs', { id: imageInfo.blockID }, (resp) => {
          let mindMapData = '';
          if (resp && resp.data && resp.data['custom-markmap']) {
            mindMapData = resp.data['custom-markmap'];
          }
          initVditor(mindMapData || '');
        });
      } catch (err) {
        initVditor('');
      }
    } else {
      initVditor('');
    }
  }


  public fixImageContent(imageDataURL: string) {
    // 解决SVG CSS5的light-dark样式在部分浏览器上无效的问题
    if (imageDataURL.startsWith('data:image/svg+xml')) {
      let base64String = imageDataURL.split(',').pop();
      let svgContent = base64ToUnicode(base64String);
      const regex = /light-dark\s*\(\s*((?:[^(),]|\w+\([^)]*\))+)\s*,\s*(?:[^(),]|\w+\([^)]*\))+\s*\)/gi;
      svgContent = svgContent.replace(regex, '$1');
      base64String = unicodeToBase64(svgContent);
      imageDataURL = `data:image/svg+xml;base64,${base64String}`;
    }
    // 设置PNG DPI
    // if (imageDataURL.startsWith('data:image/png')) {
    //   let binaryArray = base64ToArray(imageDataURL.split(',').pop());
    //   binaryArray = insertPNGpHYs(binaryArray, 96 * 2);
    //   const base64String = arrayToBase64(binaryArray);
    //   imageDataURL = `data:image/png;base64,${base64String}`;
    // }
    // 当图像为空时，使用默认的占位图
    const imageSize = getImageSizeFromBase64(imageDataURL);
    if (imageSize && imageSize.width <= 1 && imageSize.height <= 1) {
      if (imageDataURL.startsWith('data:image/svg+xml;base64,')) {
        let base64String = imageDataURL.split(',').pop();
        let svgContent = base64ToUnicode(base64String);
        const svgElement = HTMLToElement(svgContent);
        if (svgElement) {
          const defaultSvgElement = HTMLToElement(base64ToUnicode(this.getPlaceholderImageContent('svg').split(',').pop()));
          defaultSvgElement.setAttribute('content', svgElement.getAttribute('content'));
          svgContent = defaultSvgElement.outerHTML;
          base64String = unicodeToBase64(svgContent);
          imageDataURL = `data:image/svg+xml;base64,${base64String}`;
        }
      }
      if (imageDataURL.startsWith('data:image/png;base64,')) {
        let binaryArray = base64ToArray(imageDataURL.split(',').pop());
        let defaultBinaryArray = base64ToArray(this.getPlaceholderImageContent('png').split(',').pop());
        const srcLocation = locatePNGtEXt(binaryArray);
        const destLocation = locatePNGtEXt(defaultBinaryArray);
        if (srcLocation && destLocation) {
          binaryArray = replaceSubArray(binaryArray, srcLocation, defaultBinaryArray, destLocation);
          const base64String = arrayToBase64(binaryArray);
          imageDataURL = `data:image/png;base64,${base64String}`;
        }
      }
    }
    return imageDataURL;
  }
}
