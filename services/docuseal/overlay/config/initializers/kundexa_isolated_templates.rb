# frozen_string_literal: true

Rails.application.routes.append do
  post '/api/kundexa/templates', to: 'api/kundexa_templates#create'
end

Rails.application.config.to_prepare do
  # Isolated per-envelope templates cannot be edited through the builder/API after freezing.
  Template.class_eval do
    before_update do
      frozen_before = preferences_in_database.to_h['kundexa_frozen'] == true
      if frozen_before && (changes.keys - %w[archived_at updated_at]).any?
        errors.add(:base, 'Kundexa template is immutable')
        throw :abort
      end
    end
    before_destroy do
      if preferences.to_h['kundexa_frozen'] == true
        errors.add(:base, 'Kundexa template is immutable')
        throw :abort
      end
    end
  end

  ActiveStorage::Attachment.class_eval do
    before_create do
      if record.is_a?(Template) && record.preferences.to_h['kundexa_frozen'] == true && name == 'documents'
        errors.add(:base, 'Kundexa template documents are immutable')
        throw :abort
      end
    end
    before_update do
      original = record_type_in_database == 'Template' ? Template.find_by(id: record_id_in_database) : nil
      if original&.preferences.to_h['kundexa_frozen'] == true && name_in_database == 'documents' &&
         (changes.keys - %w[updated_at]).any?
        errors.add(:base, 'Kundexa template documents are immutable')
        throw :abort
      end
    end
    before_destroy do
      if record.is_a?(Template) && record.preferences.to_h['kundexa_frozen'] == true && name == 'documents'
        errors.add(:base, 'Kundexa template documents are immutable')
        throw :abort
      end
    end
  end
end
