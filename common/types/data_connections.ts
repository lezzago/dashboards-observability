/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EuiComboBoxOptionOption } from '@elastic/eui';

export interface PermissionsConfigurationProps {
  roles: Role[];
  selectedRoles: Role[];
  setSelectedRoles: React.Dispatch<React.SetStateAction<Role[]>>;
  layout: 'horizontal' | 'vertical';
  hasSecurityAccess: boolean;
}

export type Role = EuiComboBoxOptionOption;

export type DatasourceType = 'S3GLUE' | 'PROMETHEUS';
