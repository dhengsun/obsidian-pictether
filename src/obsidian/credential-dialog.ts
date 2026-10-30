import { t } from '../core/i18n';
import { App, Modal, Setting, type ButtonComponent, type TextComponent } from 'obsidian';
import type { CredentialProfile } from '../core/state';
import { cloudFailureMessage } from '../core/r2';
import { CredentialsManager, type CredentialDraft, type CredentialTest } from './credentials';

export class CredentialDialog extends Modal {
  private draft: CredentialDraft;
  private receipt?: CredentialTest;
  private alive = false;
  private busy = false;
  private controls: (TextComponent | ButtonComponent)[] = [];
  constructor(
    app: App,
    private manager: CredentialsManager,
    private saved: () => Promise<void>,
    profile?: CredentialProfile,
    private initialStatus: 'ok' | 'error' | 'untested' = 'untested',
  ) {
    super(app);
    this.draft = {
      id: profile?.id,
      name: profile?.name ?? t('新凭据'),
      accessKeyId: '',
      secretAccessKey: '',
    };
  }
  onOpen(): void {
    this.alive = true;
    this.modalEl.classList.add('pictether-credential-modal');
    const root = this.contentEl;
    new Setting(root).setName(this.draft.id ? t('编辑 RK') : t('新增 RK')).setHeading();
    root.createEl('p', {
      text: t('直接填写访问凭据，测试后保存。'),
      cls: 'pictether-settings-caption',
    });
    new Setting(root).setName(t('名称')).addText((input) => {
      input.setValue(this.draft.name).onChange((value) => {
        this.draft.name = value;
      });
      this.controls.push(input);
    });
    const feedback = root.createDiv({
      cls: 'pictether-credential-feedback',
      attr: { 'aria-live': 'polite' },
    });
    const show = (status: 'untested' | 'ok' | 'error', text: string) => {
      feedback.empty();
      feedback.createSpan({ cls: `pictether-status-dot is-${status}` });
      feedback.createSpan({ text });
    };
    for (const [key, label] of [
      ['accessKeyId', 'Access Key ID'],
      ['secretAccessKey', 'Secret Access Key'],
    ] as const)
      new Setting(root).setName(label).addText((input) => {
        input.inputEl.type = 'password';
        input.inputEl.autocomplete = 'off';
        input.inputEl.spellcheck = false;
        input
          .setValue('')
          .setPlaceholder(this.draft.id ? t('••••••••（已保存，留空保留）') : t('填写 {0}', label))
          .onChange((value) => {
            this.draft[key] = value;
            this.receipt = undefined;
            show('untested', t('未测试'));
          });
        this.controls.push(input);
      });
    root.appendChild(feedback);
    show(
      this.initialStatus,
      this.draft.id
        ? this.initialStatus === 'ok'
          ? t('连接正常 · 留空沿用已保存凭据')
          : this.initialStatus === 'error'
            ? t('上次测试失败，可重新测试或填写两项替换。')
            : t('留空可测试已保存凭据；替换时同时填写两项。')
        : t('未测试'),
    );
    const busy = (value: boolean) => {
      this.busy = value;
      for (const control of this.controls) control.setDisabled(value);
    };
    const actions = new Setting(root).setClass('pictether-dialog-actions');
    let cancel: ButtonComponent;
    actions.addButton((button) => {
      this.controls.push(button);
      button.setButtonText(t('测试连接')).onClick(() => {
        if (this.busy) return;
        busy(true);
        show('untested', t('测试中…'));
        void this.manager
          .test({ ...this.draft })
          .then((result) => {
            if (this.alive) {
              this.receipt = result;
              show(result.status, result.message);
            }
          })
          .catch((error) => {
            if (this.alive) show('error', cloudFailureMessage(error));
          })
          .finally(() => {
            if (this.alive) busy(false);
          });
      });
    });
    actions.addButton((button) => {
      cancel = button;
      button.setButtonText(t('取消')).onClick(() => this.close());
    });
    actions.addButton((button) => {
      this.controls.push(button);
      button
        .setButtonText(t('保存'))
        .setCta()
        .onClick(() => {
          if (this.busy) return;
          busy(true);
          cancel.setDisabled(true);
          void this.manager
            .save({ ...this.draft }, this.receipt)
            .then(() => this.saved())
            .then(() => {
              if (this.alive) this.close();
            })
            .catch((error) => {
              if (this.alive) show('error', cloudFailureMessage(error));
            })
            .finally(() => {
              if (this.alive) {
                busy(false);
                cancel.setDisabled(false);
              }
            });
        });
    });
  }
  onClose(): void {
    this.alive = false;
    this.draft.accessKeyId = this.draft.secretAccessKey = '';
    this.receipt = undefined;
    for (const input of this.contentEl.querySelectorAll('input')) input.value = '';
    this.contentEl.empty();
    this.controls = [];
  }
}
