/**
 * Клиентская поверхность модуля: только чистые правила, без базы и S3.
 * Форма загрузки проверяет файл теми же функциями, что и сервер.
 */
export {
  describeRejection,
  imageMimes,
  kindOf,
  type Limits,
  type MediaKind,
  type RejectionReason,
  type ValidationResult,
  validateUpload,
  videoMimes,
} from "./limits";
