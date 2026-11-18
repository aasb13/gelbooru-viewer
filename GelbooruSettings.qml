import QtQuick
import qs.Common
import qs.DCommon.Widgets
import qs.Modules.Plugins

PluginSettings {
    id: root

    pluginId: "gelbooruDux"

    StyledText {
        width: parent.width
        text: "Connection"
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Theme.fontWeightMedium
        color: Theme.surfaceText
    }

    StringSetting {
        settingKey: "userId"
        label: "Gelbooru user ID"
        description: "Your numeric account ID from gelbooru.com account settings. The API rejects all requests without credentials."
        placeholder: "e.g. 12345"
        defaultValue: ""
    }

    StringSetting {
        settingKey: "apiKey"
        label: "Gelbooru API key"
        description: "Create one under account settings > API on gelbooru.com."
        placeholder: "API key"
        defaultValue: ""
    }

    StyledText {
        width: parent.width
        text: "Content"
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Theme.fontWeightMedium
        color: Theme.surfaceText
    }

    SelectionSetting {
        settingKey: "ratingFilter"
        label: "Rating filter"
        description: "Only posts with this rating are shown, on every surface. Applied on top of any rating tag in the search."
        options: [
            { label: "General", value: "general" },
            { label: "Sensitive", value: "sensitive" },
            { label: "Questionable", value: "questionable" },
            { label: "Explicit", value: "explicit" }
        ]
        defaultValue: "general"
    }

    StyledText {
        width: parent.width
        text: "View"
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Theme.fontWeightMedium
        color: Theme.surfaceText
    }

    SliderSetting {
        settingKey: "refreshInterval"
        label: "Refresh interval"
        description: "Minutes between automatic refreshes while the viewer window is open"
        defaultValue: 10
        minimum: 1
        maximum: 60
        unit: "min"
        startIcon: "schedule"
    }

    SliderSetting {
        settingKey: "gridColumns"
        label: "Grid columns"
        description: "Thumbnails per row in the gallery grid"
        defaultValue: 3
        minimum: 2
        maximum: 8
        endIcon: "grid_view"
    }
}
