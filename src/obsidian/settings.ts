import { t } from '../core/i18n';
import {
  App,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingGroup,
  setIcon,
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
  type ButtonComponent,
  requireApiVersion,
} from 'obsidian';
import path from 'node:path';
import type { LocalResetPlan } from '../core/reset';
import type { JobStore } from '../core/job-store';
import {
  credentialFingerprint,
  selectCredential,
  type Settings,
  type StateStore,
  type CredentialProfile,
} from '../core/state';
import {
  CloudConfigurationError,
  cloudFailureMessage,
  validateR2Bucket,
  validateR2Endpoint,
} from '../core/r2';
import { CredentialsManager } from './credentials';
import { CredentialDialog } from './credential-dialog';

interface SettingsRow extends SettingDefinitionRender {
  render: (setting: Setting) => void | (() => void);
}

export interface CloudSettingsActions {
  credentials: CredentialsManager;
  apply(): Promise<void>;
  update(change: (settings: Settings) => void): Promise<void>;
  removeCredential(id: string): Promise<void>;
  restore(): Promise<void>;
  reviewReset(): Promise<LocalResetPlan>;
  reset(review: LocalResetPlan): Promise<void>;
}
export function profileStatus(
  settings: Settings,
  profile: CredentialProfile,
): 'ok' | 'error' | 'untested' {
  return profile.test?.fingerprint === credentialFingerprint(settings, profile)
    ? profile.test.status
    : 'untested';
}
function destructive(button: ButtonComponent): ButtonComponent {
  if (requireApiVersion('1.13.0')) button.setDestructive();
  else button.buttonEl.addClass('mod-warning');
  return button;
}
function confirmAction(
  app: App,
  title: string,
  description: string,
  run: () => Promise<void>,
): void {
  new (class extends Modal {
    onOpen(): void {
      this.modalEl.classList.add('pictether-confirm-modal');
      new Setting(this.contentEl).setName(title).setHeading();
      this.contentEl.createEl('p', { text: description });
      const result = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      new Setting(this.contentEl)
        .setClass('pictether-dialog-actions')
        .addButton((button) => button.setButtonText(t('取消')).onClick(() => this.close()))
        .addButton((button) =>
          destructive(button)
            .setButtonText(t('确认'))
            .onClick(() => {
              button.setDisabled(true);
              void run()
                .then(() => this.close())
                .catch((error) => {
                  result.setText(cloudFailureMessage(error));
                  button.setDisabled(false);
                });
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  })(app).open();
}
export class PictetherSettings extends PluginSettingTab {
  private generation = 0;
  private stopStatistics?: () => void;
  private dialog?: CredentialDialog;
  private menu?: Menu;
  private resetDialog?: Modal;
  private confirmReset(done: () => void): void {
    if (!this.actions) return;
    this.resetDialog?.close();
    const actions = this.actions;
    this.resetDialog = new (class extends Modal {
      private closed = false;
      onOpen(): void {
        this.modalEl.classList.add('pictether-reset-modal');
        new Setting(this.contentEl).setName(t('重置 Pictether')).setHeading();
        this.contentEl.createEl('p', {
          text: t(
            '删除当前附件根目录下所有命名空间的受管理附件，并清空配置、记录、统计与插件密钥。笔记和云端保留。',
          ),
        });
        const summary = this.contentEl.createEl('p', {
          text: t('正在检查本地附件…'),
          cls: 'pictether-reset-summary',
        });
        const label = this.contentEl.createEl('label', { cls: 'pictether-reset-ack' });
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
        checkbox.disabled = true;
        label.createSpan({
          text: t('我确认共用此目录的其他库也受影响，未备份的本地附件将永久丢失。'),
        });
        const feedback = this.contentEl.createEl('p', { attr: { role: 'alert' } });
        let review: LocalResetPlan | undefined,
          working = false,
          confirm!: import('obsidian').ButtonComponent;
        checkbox.addEventListener('change', () => {
          confirm.setDisabled(!review || !checkbox.checked || working);
        });
        new Setting(this.contentEl)
          .setClass('pictether-dialog-actions')
          .addButton((button) =>
            button.setButtonText(t('取消')).onClick(() => {
              if (!working) this.close();
            }),
          )
          .addButton((button) => {
            confirm = button;
            destructive(button)
              .setButtonText(t('删除本地附件并重置'))
              .setDisabled(true)
              .onClick(() => {
                if (!review || !checkbox.checked || working) return;
                working = true;
                button.setDisabled(true);
                checkbox.disabled = true;
                void actions
                  .reset(review)
                  .then(() => {
                    this.close();
                    done();
                  })
                  .catch((error) => {
                    feedback.setText(cloudFailureMessage(error));
                    summary.setText(t('请关闭此窗口，重新检查范围后继续重置。'));
                    review = undefined;
                    working = false;
                    done();
                  });
              });
          });
        void actions
          .reviewReset()
          .then((value) => {
            if (this.closed) return;
            review = value;
            summary.setText(
              t(
                '本地目录：{0}\n{1} 个命名空间，{2} 个附件。{3}',
                value.root,
                value.namespaces,
                value.files,
                value.unknown ? t('另有 {0} 个未识别项目会保留。', value.unknown) : '',
              ),
            );
            checkbox.disabled = false;
          })
          .catch((error) => {
            if (!this.closed) {
              summary.setText(t('无法确认删除范围，重置未开始。'));
              feedback.setText(cloudFailureMessage(error));
            }
          });
      }
      onClose(): void {
        this.closed = true;
        this.contentEl.empty();
      }
    })(this.app);
    this.resetDialog.open();
  }
  constructor(
    app: App,
    plugin: Plugin,
    private state: StateStore,
    private jobs?: JobStore,
    private actions?: CloudSettingsActions,
  ) {
    super(app, plugin);
  }
  /** Pure definitions: the host calls this before opening the tab to index search. */
  getSettingDefinitions(): SettingDefinitionGroup[] {
    const settings = this.state.snapshot().settings;
    let endpoint = settings.endpoint,
      bucket = settings.bucket,
      region = settings.region,
      dirty = false;
    let generation = this.generation;
    const current = () => generation === this.generation;
    const run = async (work: () => Promise<void>) => {
      try {
        await work();
        if (current()) this.refreshSettings();
      } catch (error) {
        if (current()) new Notice(`Pictether: ${cloudFailureMessage(error)}`, 10000);
      }
    };
    const commit = (change: (value: Settings) => void) =>
      this.actions
        ? this.actions.update(change)
        : this.state.update((next) => change(next.settings));
    const disabled = !this.jobs || settings.resetPending;
    const action = (setting: Setting, text: string, work: () => Promise<void>) => {
      // Keep a small native button outside the setting card's row layout.
      setting.settingEl.empty();
      setting.settingEl.removeClass('setting-item');
      setting.settingEl.addClass('pictether-section-actions');
      const button = setting.settingEl.createEl('button', { text, attr: { type: 'button' } });
      button.disabled = disabled;
      button.addEventListener('click', () => {
        button.disabled = true;
        void run(work).finally(() => {
          if (current()) button.disabled = disabled;
        });
      });
    };
    const row = (name: string, render: SettingsRow['render'], desc?: string): SettingsRow => ({
      name,
      desc,
      render,
    });
    const group = (
      heading: string | undefined,
      items: SettingsRow[],
      cls = 'pictether-settings-section',
    ): SettingDefinitionGroup => ({
      type: 'group',
      heading,
      cls,
      items,
    });
    return [
      group(t('通用设置'), [
        row(
          t('附件根目录'),
          (setting) => {
            this.releaseView();
            generation = this.generation;
            this.containerEl.addClass('pictether-settings');
            return this.mountRootEditor(setting, disabled, commit, current);
          },
          t('附件统一保存在此目录。'),
        ),
        row(t('仓库名'), (setting) => {
          const name = this.app.vault.getName();
          setting.setClass('pictether-vault-setting').controlEl.createSpan({
            text: name,
            cls: 'pictether-readonly-value',
            attr: { title: name },
          });
        }),
      ]),
      group(t('OSS 配置'), [
        row(t('服务地址'), (setting) => {
          setting.addText((input) =>
            input.setValue(endpoint).onChange((value) => {
              endpoint = value;
              dirty = true;
            }),
          );
        }),
        row(t('存储桶'), (setting) => {
          setting.addText((input) =>
            input.setValue(bucket).onChange((value) => {
              bucket = value;
              dirty = true;
            }),
          );
        }),
        row(
          t('签名区域'),
          (setting) => {
            setting.addText((input) =>
              input.setValue(region).onChange((value) => {
                region = value;
                dirty = true;
              }),
            );
          },
          t('R2 使用 auto，其他服务按其 S3 配置填写。'),
        ),
      ]),
      group(
        undefined,
        [
          row(t('保存 OSS 配置'), (setting) =>
            action(setting, t('保存 OSS 配置'), async () => {
              const values = {
                endpoint: endpoint.trim(),
                bucket: bucket.trim(),
                region: region.trim(),
              };
              if (values.endpoint) validateR2Endpoint(values.endpoint);
              if (values.bucket) validateR2Bucket(values.bucket);
              if (!/^[a-zA-Z0-9-]{1,64}$/.test(values.region))
                throw new CloudConfigurationError(t('签名区域格式无效。'));
              await commit((next) => {
                next.endpoint = values.endpoint ? new URL(values.endpoint).origin : '';
                next.bucket = values.bucket;
                next.region = values.region;
              });
            }),
          ),
        ],
        'pictether-settings-section pictether-settings-actions-group',
      ),
      group(undefined, [
        row(t('RK 访问凭据'), (setting) => {
          setting.settingEl.empty();
          setting.settingEl.removeClass('setting-item');
          const credentials = setting.settingEl.createDiv({ cls: 'pictether-credentials' });
          const header = credentials.createDiv({ cls: 'pictether-rk-heading' });
          header.createSpan({ text: t('RK 访问凭据') });
          const open = (profile?: CredentialProfile) => {
            if (!this.actions || settings.resetPending) return;
            if (dirty) {
              new Notice(t('请先保存 OSS 地址和存储桶。'));
              return;
            }
            this.dialog?.close();
            this.dialog = new CredentialDialog(
              this.app,
              this.actions.credentials,
              async () => {
                await this.actions?.apply();
                if (current()) this.refreshSettings();
              },
              profile,
              profile ? profileStatus(settings, profile) : 'untested',
            );
            this.dialog.open();
          };
          const add = header.createEl('button', {
            cls: 'clickable-icon pictether-icon-button',
            attr: { type: 'button', 'aria-label': t('新增 RK'), title: t('新增 RK') },
          });
          setIcon(add, 'plus');
          add.disabled = disabled;
          add.addEventListener('click', () => open());
          const list = credentials.createDiv({ cls: 'pictether-rk-list' });
          if (!settings.credentials.length) {
            const empty = list.createDiv({ cls: 'pictether-rk-empty' });
            empty.createSpan({ cls: 'pictether-status-dot is-untested' });
            empty.createSpan({ text: t('尚未添加凭据') });
          }
          for (const profile of settings.credentials) {
            const status = profileStatus(settings, profile),
              entry = list.createDiv({ cls: 'pictether-rk-row' });
            const info = entry.createDiv({ cls: 'pictether-rk-info' });
            info.createSpan({ cls: `pictether-status-dot is-${status}` });
            const identity = info.createSpan({ cls: 'pictether-rk-identity' });
            identity.createSpan({
              text: profile.name,
              cls: 'pictether-rk-name',
              attr: { title: profile.name },
            });
            identity.createSpan({ text: '••••••••', cls: 'pictether-rk-mask' });
            info.createSpan({
              text:
                status === 'ok' ? t('连接正常') : status === 'error' ? t('连接失败') : t('未测试'),
              cls: 'pictether-rk-status',
            });
            const controls = entry.createDiv({ cls: 'pictether-rk-controls' });
            if (profile.id === settings.activeCredential)
              controls.createSpan({ text: t('当前'), cls: 'pictether-rk-current' });
            else {
              const activate = controls.createEl('button', { text: t('启用') });
              activate.disabled = disabled;
              activate.addEventListener('click', () => {
                activate.disabled = true;
                void run(() => commit((next) => selectCredential(next, profile.id)));
              });
            }
            const more = controls.createEl('button', {
              cls: 'clickable-icon pictether-icon-button pictether-rk-more',
              attr: {
                type: 'button',
                'aria-label': t('{0} 的更多操作', profile.name),
                title: t('更多操作'),
                'aria-haspopup': 'menu',
              },
            });
            setIcon(more, 'ellipsis');
            more.disabled = disabled || !this.actions;
            more.addEventListener('click', () => {
              this.menu?.hide();
              const menu = new Menu();
              this.menu = menu;
              menu.addItem((item) =>
                item
                  .setTitle(t('编辑'))
                  .setIcon('pencil')
                  .onClick(() => {
                    if (current()) open(profile);
                  }),
              );
              menu.addItem((item) =>
                item
                  .setTitle(t('删除'))
                  .setIcon('trash-2')
                  .onClick(() => {
                    if (!current()) return;
                    confirmAction(
                      this.app,
                      t('删除 RK'),
                      t('删除“{0}”及其专属密钥，笔记、本地附件和云端保持不变。', profile.name),
                      async () => {
                        try {
                          await this.actions?.removeCredential(profile.id);
                        } finally {
                          if (current()) this.refreshSettings();
                        }
                      },
                    );
                  }),
              );
              const rect = more.getBoundingClientRect();
              menu.showAtPosition({ x: rect.left, y: rect.bottom }, more.ownerDocument);
            });
          }
        }),
      ]),
      group(t('备份与恢复'), [
        row(
          t('自动备份'),
          (setting) => {
            setting.addToggle((toggle) =>
              toggle
                .setValue(settings.autoBackup)
                .setDisabled(disabled)
                .onChange((value) => {
                  toggle.setDisabled(true);
                  void run(() =>
                    commit((next) => {
                      next.autoBackup = value;
                    }),
                  ).finally(() => {
                    if (current())
                      toggle
                        .setValue(this.state.snapshot().settings.autoBackup)
                        .setDisabled(disabled);
                  });
                }),
            );
          },
          !settings.activeCredential
            ? t('启用一组 RK 后，自动备份已有及新增附件。')
            : !settings.endpoint || !settings.bucket
              ? t('填写服务地址和存储桶后开始备份。')
              : t('开启后自动备份已有及新增附件。'),
        ),
        row(
          t('恢复缺失附件'),
          (setting) => {
            setting.setClass('pictether-button-setting').addButton((button) =>
              button
                .setButtonText(t('恢复'))
                .setDisabled(disabled || !this.actions)
                .onClick(() => {
                  button.setDisabled(true);
                  void run(() => this.actions?.restore() ?? Promise.resolve()).finally(() => {
                    if (current()) button.setDisabled(disabled || !this.actions);
                  });
                }),
            );
          },
          t('从 OSS 补齐笔记引用的缺失文件。'),
        ),
        row(
          settings.resetPending ? t('重置未完成') : t('重置插件'),
          (setting) => {
            setting.setClass('pictether-button-setting').addButton((button) =>
              destructive(button)
                .setButtonText(settings.resetPending ? t('继续重置') : t('重置'))
                .setDisabled(!this.jobs || !this.actions)
                .onClick(() => {
                  this.confirmReset(() => {
                    if (current()) this.refreshSettings();
                  });
                }),
            );
          },
          t('删除当前根目录内全部受管理附件，清空配置、记录、统计和插件密钥。保留笔记与云端。'),
        ),
      ]),
      group(
        undefined,
        [row(t('备份统计'), (setting) => this.mountStatistics(setting))],
        'pictether-settings-section pictether-statistics-footer',
      ),
    ];
  }
  /** Retained for the declared minimum host version, which predates definitions. */
  display(): void {
    this.renderLegacy();
  }
  private renderLegacy(): void {
    this.releaseView();
    const root = this.containerEl;
    root.empty();
    root.addClass('pictether-settings');
    for (const definition of this.getSettingDefinitions()) {
      const shell = root.createDiv({ cls: definition.cls });
      const group = new SettingGroup(shell);
      if (definition.heading) group.setHeading(definition.heading);
      for (const item of definition.items ?? []) {
        if (!('render' in item) || !item.render) continue;
        const setting = new Setting(group.listEl).setName(item.name);
        if (item.desc) setting.setDesc(item.desc);
        item.render(setting, group);
      }
    }
  }

  private mountRootEditor(
    setting: Setting,
    disabled: boolean,
    commit: (change: (settings: Settings) => void) => Promise<void>,
    current: () => boolean,
  ): () => void {
    let alive = true,
      working = false;
    const active = () => alive && current();
    setting.setClass('pictether-path-setting');
    setting.controlEl.addClass('pictether-path-control');
    const display = () => {
      setting.controlEl.empty();
      const value = this.state.snapshot().settings.assetsRoot;
      const button = setting.controlEl.createEl('button', {
        cls: 'pictether-path-display',
        attr: { type: 'button', title: value, 'aria-label': t('编辑附件根目录') },
      });
      button.disabled = disabled;
      button.createSpan({ text: value, cls: 'pictether-path-value' });
      setIcon(button.createSpan({ cls: 'pictether-path-pencil' }), 'pencil');
      button.addEventListener('click', () => {
        if (active()) edit();
      });
    };
    const edit = () => {
      setting.controlEl.empty();
      let draft = this.state.snapshot().settings.assetsRoot;
      setting.addText((input) => {
        input.setValue(draft).onChange((value) => {
          draft = value;
        });
        input.inputEl.setAttribute('aria-label', t('附件根目录'));
        const confirm = setting.controlEl.createEl('button', {
          cls: 'clickable-icon pictether-icon-button pictether-path-confirm',
          attr: { type: 'button', 'aria-label': t('保存附件根目录'), title: t('保存附件根目录') },
        });
        setIcon(confirm, 'check');
        const feedback = setting.controlEl.createSpan({
          cls: 'pictether-path-feedback',
          attr: { role: 'alert' },
        });
        const save = () => {
          if (working || !active()) return;
          const value = draft.trim();
          if (!path.isAbsolute(value)) {
            feedback.setText(t('附件根目录必须为绝对路径。'));
            return;
          }
          if (value === this.state.snapshot().settings.assetsRoot) {
            display();
            return;
          }
          working = true;
          input.setDisabled(true);
          confirm.disabled = true;
          feedback.setText('');
          void commit((next) => {
            next.assetsRoot = value;
          })
            .then(() => {
              if (active()) display();
            })
            .catch((error) => {
              if (active()) feedback.setText(cloudFailureMessage(error));
            })
            .finally(() => {
              working = false;
              if (active()) {
                input.setDisabled(false);
                confirm.disabled = false;
              }
            });
        };
        confirm.addEventListener('click', save);
        input.inputEl.addEventListener('keydown', (event) => {
          if (event.isComposing || working) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            display();
          }
        });
        input.inputEl.focus();
        input.inputEl.select();
      });
    };
    display();
    return () => {
      alive = false;
    };
  }
  private refreshSettings(): void {
    this.releaseView();
    if (requireApiVersion('1.13.0')) this.update();
    else this.renderLegacy();
  }
  private mountStatistics(setting: Setting): () => void {
    this.stopStatistics?.();
    const generation = this.generation,
      root = setting.settingEl;
    root.empty();
    root.removeClass('setting-item');
    const summary = root.createEl('p', {
      text: t('备份{0}，成功{1}，冲突{2}，失败{3}', '—', '—', '—', '—'),
      cls: 'pictether-stats-summary',
      attr: { 'aria-live': 'polite' },
    });
    if (!this.jobs) summary.setText(t('统计暂不可用'));
    let refreshId = 0,
      alive = true;
    const refresh = async () => {
      if (!this.jobs || !alive) return;
      const request = ++refreshId,
        current = this.state.snapshot().settings;
      let target = '';
      try {
        if (current.endpoint) target = `${new URL(current.endpoint).origin}/${current.bucket}`;
      } catch {
        /* Incomplete configuration has no target. */
      }
      try {
        const stats = await this.jobs.totals(current.assetsRoot, target);
        if (!alive || generation !== this.generation || request !== refreshId) return;
        const text = t(
          '备份{0}，成功{1}，冲突{2}，失败{3}',
          stats.attempts,
          stats.success,
          stats.conflict,
          stats.failed,
        );
        if (summary.textContent !== text) summary.setText(text);
      } catch {
        if (alive && generation === this.generation) summary.setText(t('统计暂不可用'));
      }
    };
    const owner = this.containerEl.win;
    void refresh();
    const timer = owner.setInterval(() => {
      if (root.isConnected) void refresh();
    }, 5000);
    const stop = () => {
      alive = false;
      owner.clearInterval(timer);
      if (this.stopStatistics === stop) this.stopStatistics = undefined;
    };
    this.stopStatistics = stop;
    return stop;
  }
  private releaseView(): void {
    this.generation++;
    this.stopStatistics?.();
    this.menu?.hide();
    this.menu = undefined;
  }
  hide(): void {
    this.releaseView();
    this.dialog?.close();
    this.dialog = undefined;
    this.resetDialog?.close();
    this.resetDialog = undefined;
  }
}
