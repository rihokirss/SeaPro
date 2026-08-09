import ReactDatePicker from 'react-datepicker';
import { enGB, et, fi } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { localeTag, useI18n } from '../i18n';
import 'react-datepicker/dist/react-datepicker.css';

interface Props {
  value: string;
  onChange(value: string): void;
}

export function LocalizedDateTimePicker({ value, onChange }: Props) {
  const { lang, t } = useI18n();
  const dateLocale = lang === 'et' ? et : lang === 'fi' ? fi : enGB;

  return <ReactDatePicker
    selected={new Date(value)}
    onChange={(date: Date | null) => { if (date) onChange(date.toISOString()); }}
    locale={dateLocale}
    dateFormat={lang === 'en' ? 'dd/MM/yyyy HH:mm' : 'dd.MM.yyyy HH:mm'}
    showTimeInput
    timeFormat="HH:mm"
    timeInputLabel={t('route.time')}
    calendarStartDay={1}
    className="route-date-input"
    wrapperClassName="route-date-picker"
    calendarClassName="route-calendar"
    popperClassName="route-date-popper"
    portalId="route-datepicker-portal"
    popperPlacement="bottom-start"
    showPopperArrow={false}
    shouldCloseOnSelect={false}
    previousMonthAriaLabel={t('route.previousMonth')}
    nextMonthAriaLabel={t('route.nextMonth')}
    renderCustomHeader={({ date, decreaseMonth, increaseMonth, prevMonthButtonDisabled, nextMonthButtonDisabled }) => <div className="route-calendar__header">
      <button type="button" onClick={decreaseMonth} disabled={prevMonthButtonDisabled} aria-label={t('route.previousMonth')}><ChevronLeft size={19} aria-hidden="true" /></button>
      <strong>{date.toLocaleDateString(localeTag(lang), { month: 'long', year: 'numeric' })}</strong>
      <button type="button" onClick={increaseMonth} disabled={nextMonthButtonDisabled} aria-label={t('route.nextMonth')}><ChevronRight size={19} aria-hidden="true" /></button>
    </div>}
  />;
}
